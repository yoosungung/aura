import assert from "node:assert/strict";
import test from "node:test";
import { createFrame } from "./frame.js";
import { encode } from "./protocol.js";

function fakeFrame({ parentOrigin = "https://shop.example", origin = "https://help.example" } = {}) {
  const listeners = [];
  const posted = [];
  const win = {
    location: {
      origin,
      search: `?parent_origin=${encodeURIComponent(parentOrigin)}`,
    },
    parent: {
      postMessage(data, target) {
        posted.push({ data, target });
      },
    },
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    deliver(event) {
      for (const fn of listeners) fn({ source: win.parent, ...event });
    },
    document: {
      getElementById() {
        return null;
      },
    },
  };
  win.posted = posted;
  return win;
}

test("frame posts ready to parent origin never wildcard", () => {
  const win = fakeFrame();
  createFrame(win, { fetch() {}, WebSocket: function WS() {} });
  assert.equal(win.posted.length, 1);
  assert.equal(win.posted[0].target, "https://shop.example");
  assert.equal(win.posted[0].data.event, "ready");
  assert.notEqual(win.posted[0].target, "*");
});

test("frame ignores init from a foreign origin", async () => {
  const win = fakeFrame();
  const calls = [];
  const frame = createFrame(win, {
    fetch(...args) {
      calls.push(args);
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "next" }),
      });
    },
    WebSocket: function WS() {},
  });
  win.deliver({
    origin: "https://evil.example",
    data: encode("init", { token: "stolen", inboxId: "inbox-1" }),
  });
  await assert.rejects(() => frame.send("hi"));
  assert.equal(calls.length, 0);
});

test("frame ignores parent-origin messages from another window", async () => {
  const win = fakeFrame();
  const calls = [];
  const frame = createFrame(win, {
    fetch(...args) {
      calls.push(args);
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "next" }),
      });
    },
    WebSocket: function WS() {},
  });
  win.deliver({
    origin: "https://shop.example",
    source: {},
    data: encode("init", { token: "stolen", inboxId: "inbox-1" }),
  });
  await assert.rejects(() => frame.send("hi"));
  assert.equal(calls.length, 0);
});

test("frame reconnects websocket after an unexpected close", async () => {
  const win = fakeFrame();
  let auths = 0;
  const socks = [];
  createFrame(win, {
    async fetch(url) {
      if (String(url).endsWith("/auth")) {
        auths += 1;
        return { ok: true, json: async () => ({ access_token: `access-${auths}` }) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        socks.push(this);
      }
      close() {
        this.readyState = 3;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(socks.length, 1);
  socks[0].onclose();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(auths, 2);
  assert.equal(socks.length, 2);
  assert.match(socks[1].url, /access-2/);
});

test("frame counts unread only while closed", async () => {
  const win = fakeFrame();
  let sock;
  const frame = createFrame(win, {
    async fetch(url) {
      if (String(url).endsWith("/auth")) {
        return { ok: true, json: async () => ({ access_token: "access" }) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor() {
        sock = this;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("hi");
  const agent = {
    data: JSON.stringify({
      type: "event",
      event: "message.created",
      conversation_id: "c1",
      message: { payload: { content: "hello", sender_type: "User" } },
    }),
  };
  sock.onmessage(agent);
  const unread = win.posted.filter((p) => p.data.event === "unread");
  assert.equal(unread.at(-1).data.payload.count, 1);
  win.deliver({
    origin: "https://shop.example",
    data: encode("toggle", { open: true }),
  });
  sock.onmessage(agent);
  assert.equal(win.posted.filter((p) => p.data.event === "unread").length, unread.length);
  win.deliver({
    origin: "https://shop.example",
    data: encode("toggle", { open: false }),
  });
  sock.onmessage(agent);
  assert.equal(win.posted.filter((p) => p.data.event === "unread").at(-1).data.payload.count, 1);
});

test("frame send uses own origin API after parent init", async () => {
  const win = fakeFrame();
  const calls = [];
  const frame = createFrame(win, {
    async fetch(url, opts) {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({ token: "rotated", conversation_id: "c1" }),
      };
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("결제 오류");
  assert.equal(
    calls[0].url,
    "https://help.example/public/api/v1/inboxes/inbox-1/auth",
  );
  assert.equal(JSON.parse(calls[0].opts.body).pubsub_token, "guest");
  assert.equal(
    calls[1].url,
    "https://help.example/public/api/v1/inboxes/inbox-1/messages",
  );
  assert.equal(calls[1].opts.headers.Authorization, "Bearer rotated");
  assert.equal(JSON.parse(calls[1].opts.body).content, "결제 오류");
  assert.equal(frame.token(), "rotated");
});

test("frame reuses an open websocket across sends", async () => {
  const win = fakeFrame();
  const socks = [];
  const frame = createFrame(win, {
    async fetch(url) {
      if (String(url).endsWith("/auth")) {
        return { ok: true, json: async () => ({ access_token: "access" }) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        socks.push(this);
      }
      close() {
        this.readyState = 3;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("하나");
  await frame.send("둘");
  assert.equal(socks.length, 1);
});

test("setUser with identifier_hash posts identify", async () => {
  const win = fakeFrame();
  const calls = [];
  const frame = createFrame(win, {
    async fetch(url, opts) {
      calls.push({ url, opts });
      if (String(url).endsWith("/auth")) {
        return { ok: true, json: async () => ({ access_token: "access" }) };
      }
      return { ok: true, json: async () => ({ identifier: "user-1" }) };
    },
    WebSocket: function WS() {},
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("setUser", { identifier: "user-1", identifier_hash: "abc", name: "Ada" }),
  });
  await new Promise((r) => setTimeout(r, 0));
  const identify = calls.find((c) => String(c.url).endsWith("/identify"));
  assert.ok(identify);
  assert.equal(identify.url, "https://help.example/public/api/v1/inboxes/inbox-1/identify");
  assert.equal(JSON.parse(identify.opts.body).identifier_hash, "abc");
  assert.equal(frame.identifier(), "user-1");
});

function messageLog() {
  const items = [];
  const buttons = [];
  return {
    items,
    buttons,
    document: {
      createElement(tag) {
        const el = {
          tagName: tag,
          textContent: "",
          dataset: {},
          type: "",
          className: "",
          attrs: {},
          children: [],
          addEventListener(type, fn) {
            if (type === "click") buttons.push(fn);
          },
          setAttribute(name, value) {
            this.attrs[name] = value;
          },
          appendChild(child) {
            this.children.push(child);
          },
        };
        return el;
      },
      createTextNode(text) {
        return { textContent: text };
      },
      getElementById() {
        return {
          appendChild(child) {
            items.push(child);
          },
        };
      },
    },
  };
}

test("frame reauths CSAT after 401", async () => {
  const win = fakeFrame();
  const calls = [];
  const log = messageLog();
  let sock;
  let auths = 0;
  let csats = 0;
  win.document = log.document;
  const frame = createFrame(win, {
    async fetch(url, opts) {
      calls.push({ url, opts });
      if (String(url).endsWith("/auth")) {
        auths += 1;
        return { ok: true, json: async () => ({ access_token: `access-${auths}` }) };
      }
      if (String(url).endsWith("/csat")) {
        csats += 1;
        if (csats === 1) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor() {
        sock = this;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("hi");
  sock.onmessage({
    data: JSON.stringify({
      type: "event",
      event: "message.created",
      conversation_id: "c1",
      message: { payload: { content_type: "input_csat", content: "상담은 어떠셨나요?" } },
    }),
  });
  await log.buttons[4]();
  assert.equal(auths, 2);
  assert.equal(csats, 2);
  assert.equal(frame.token(), "access-2");
});

test("frame rates CSAT over public API", async () => {
  const win = fakeFrame();
  const calls = [];
  const log = messageLog();
  let sock;
  win.document = log.document;
  const frame = createFrame(win, {
    async fetch(url, opts) {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ token: "guest" }) };
    },
    WebSocket: class {
      constructor() {
        sock = this;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("hi");
  sock.onmessage({
    data: JSON.stringify({
      type: "event",
      event: "message.created",
      conversation_id: "c1",
      message: { payload: { content_type: "input_csat", content: "상담은 어떠셨나요?" } },
    }),
  });
  assert.equal(log.buttons.length, 5);
  const card = log.items.find((el) => el.dataset.csat === "true");
  assert.equal(card.className, "csat");
  assert.equal(card.attrs["aria-label"], "상담 만족도를 평가해 주세요");
  assert.match(card.children[0].textContent, /^⭐ /);
  await log.buttons[4]();
  const csat = calls.find((c) => String(c.url).endsWith("/csat"));
  assert.equal(csat.url, "https://help.example/public/api/v1/inboxes/inbox-1/csat");
  assert.equal(JSON.parse(csat.opts.body).rating, 5);
});

test("frame marks agent and customer bubbles for the widget timeline", async () => {
  const win = fakeFrame();
  const log = messageLog();
  let sock;
  win.document = log.document;
  const frame = createFrame(win, {
    async fetch(url) {
      if (String(url).endsWith("/auth")) {
        return { ok: true, json: async () => ({ access_token: "access" }) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor() {
        sock = this;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("결제 문의드립니다.");
  sock.onmessage({
    data: JSON.stringify({
      type: "event",
      event: "message.created",
      conversation_id: "c1",
      message: { payload: { content: "안녕하세요! 무엇을 도와드릴까요", sender_type: "User" } },
    }),
  });
  assert.equal(log.items[0].dataset.sender, "Contact");
  assert.equal(log.items[0].children[0].textContent, "고객");
  assert.equal(log.items[1].dataset.sender, "User");
  assert.equal(log.items[1].children[0].textContent, "상담원");
});

test("frame does not paint a contact websocket echo after send", async () => {
  const win = fakeFrame();
  const log = messageLog();
  let sock;
  win.document = log.document;
  const frame = createFrame(win, {
    async fetch(url) {
      if (String(url).endsWith("/auth")) {
        return { ok: true, json: async () => ({ access_token: "access" }) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor() {
        sock = this;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("결제 문의드립니다.");
  sock.onmessage({
    data: JSON.stringify({
      type: "event",
      event: "message.created",
      conversation_id: "c1",
      message: { payload: { content: "결제 문의드립니다.", sender_type: "Contact" } },
    }),
  });
  assert.equal(log.items.length, 1);
  assert.equal(log.items[0].dataset.sender, "Contact");
});

test("frame exchanges a new access token after 401 and retries send", async () => {
  const win = fakeFrame();
  let auths = 0;
  let messages = 0;
  const socks = [];
  const frame = createFrame(win, {
    async fetch(url) {
      if (String(url).endsWith("/auth")) {
        auths += 1;
        return { ok: true, json: async () => ({ access_token: `access-${auths}` }) };
      }
      messages += 1;
      if (messages === 1) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ conversation_id: "c1" }) };
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        socks.push(this);
      }
      close() {
        this.readyState = 3;
      }
    },
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  await frame.send("hi");
  assert.equal(auths, 2);
  assert.equal(messages, 2);
  assert.equal(frame.token(), "access-2");
  assert.equal(socks.length, 2);
  assert.match(socks[1].url, /access-2/);
});

test("setUser without identifier_hash does not bind identity", async () => {
  const win = fakeFrame();
  const frame = createFrame(win, {
    fetch() {
      throw new Error("should not fetch");
    },
    WebSocket: function WS() {},
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("init", { token: "guest", inboxId: "inbox-1" }),
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("setUser", { identifier: "user-1", name: "Ada" }),
  });
  assert.equal(frame.identifier(), "");
});
