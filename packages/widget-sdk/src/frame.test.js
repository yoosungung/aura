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
      for (const fn of listeners) fn(event);
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
    "https://help.example/public/api/v1/inboxes/inbox-1/messages",
  );
  assert.equal(calls[0].opts.headers.Authorization, "Bearer guest");
  assert.equal(JSON.parse(calls[0].opts.body).content, "결제 오류");
  assert.equal(frame.token(), "rotated");
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
