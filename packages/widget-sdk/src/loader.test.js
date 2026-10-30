import assert from "node:assert/strict";
import test from "node:test";
import { createLoader } from "./loader.js";
import { encode } from "./protocol.js";

function fakeHost(origin = "https://shop.example") {
  const listeners = [];
  const body = {
    children: [],
    appendChild(el) {
      this.children.push(el);
    },
  };
  const doc = {
    getElementById(id) {
      return body.children.find((el) => el.id === id) ?? null;
    },
    createElement() {
      const el = {
        id: "",
        src: "",
        style: {},
        title: "",
        sent: [],
        children: [],
        textContent: "",
        dataset: {},
        hidden: false,
        contentWindow: {
          postMessage(data, target) {
            el.sent.push({ data, target });
          },
        },
        appendChild(child) {
          this.children.push(child);
        },
        setAttribute(name, value) {
          this.attrs = this.attrs || {};
          this.attrs[name] = value;
        },
        attachShadow() {
          this.shadow = {
            innerHTML: "",
            appendChild(child) {
              this.host = child;
            },
            querySelector() {
              return this.host;
            },
          };
          return this.shadow;
        },
      };
      return el;
    },
    body,
  };
  return {
    location: { origin },
    document: doc,
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    deliver(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

test("loader ignores messages that are not from the helpdesk origin", () => {
  const win = fakeHost();
  const api = createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
  });
  win.deliver({
    origin: "https://shop.example",
    data: encode("ready"),
  });
  assert.equal(api.iframe.sent.length, 0);
});

test("loader inits iframe with token after ready from helpdesk origin", () => {
  const win = fakeHost();
  const api = createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
  });
  assert.equal(new URL(api.iframe.src).searchParams.get("token"), null);
  win.deliver({
    origin: "https://help.example",
    data: encode("ready"),
  });
  assert.equal(api.iframe.sent.length, 1);
  assert.equal(api.iframe.sent[0].target, "https://help.example");
  assert.equal(api.iframe.sent[0].data.event, "init");
  assert.equal(api.iframe.sent[0].data.payload.token, "secret-token");
  assert.notEqual(api.iframe.sent[0].target, "*");
});

test("host button mode hides the default launcher and does not trap clicks", () => {
  const win = fakeHost();
  const api = createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
    launcher: false,
  });
  const host = win.document.body.children.find((el) => el.id === "aura-widget-host");
  assert.equal(api.open, false);
  assert.equal(host.style.display, "none");
  assert.equal(host.shadow.host.style.display, "none");
  assert.equal(
    win.document.body.children.some((el) => el.id === "aura-widget-frame"),
    false,
  );
  api.toggle();
  assert.equal(api.open, true);
  assert.equal(api.iframe.style.width, "380px");
  assert.equal(host.style.display, "none");
});

test("javascript baseUrl does not create an iframe", () => {
  const win = fakeHost();
  assert.throws(() =>
    createLoader(win, { baseUrl: "javascript:alert(1)", inboxId: "i", token: "t" }),
  );
  assert.equal(win.document.body.children.length, 0);
});

test("closed loader does not let the iframe intercept host clicks", () => {
  const win = fakeHost();
  const api = createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
  });
  assert.equal(api.open, false);
  assert.equal(api.iframe.style.display, "none");
  assert.equal(api.iframe.style.pointerEvents, "none");
  assert.equal(
    win.document.body.children.some((el) => el.id === "aura-widget-frame"),
    false,
  );
  const host = win.document.body.children.find((el) => el.id === "aura-widget-host");
  const launcher = host.shadow.host;
  assert.equal(launcher.style.width, "60px");
  assert.equal(launcher.style.height, "60px");
  assert.equal(launcher.style.borderRadius, "9999px");
  assert.equal(host.style.bottom, "20px");
  assert.equal(host.style.right, "20px");
  assert.equal(host.style.zIndex, "2147483000");
  api.toggle();
  assert.equal(api.open, true);
  assert.notEqual(api.iframe.style.display, "none");
  assert.equal(api.iframe.style.pointerEvents, "auto");
  assert.equal(api.iframe.style.width, "380px");
  assert.equal(api.iframe.style.height, "min(640px, calc(100dvh - 40px))");
  assert.equal(api.iframe.style.bottom, "20px");
  assert.equal(api.iframe.style.right, "20px");
  assert.equal(api.iframe.style.borderRadius, "16px");
  assert.equal(api.iframe.style.boxShadow, "0 20px 50px rgba(0,0,0,0.16)");
  assert.equal(
    win.document.body.children.some((el) => el.id === "aura-widget-frame"),
    true,
  );
});

test("loader paints unread count on the launcher badge", () => {
  const win = fakeHost();
  createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
  });
  const host = win.document.body.children.find((el) => el.id === "aura-widget-host");
  const badge = host.shadow.host.children.find((el) => el.dataset?.badge === "unread");
  assert.ok(badge);
  assert.equal(badge.hidden, true);
  win.deliver({
    origin: "https://help.example",
    data: encode("unread", { count: 3 }),
  });
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "3");
});

test("open loader fills the mobile viewport", () => {
  const win = fakeHost();
  win.innerWidth = 390;
  const api = createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
  });
  api.toggle();
  assert.equal(api.iframe.style.width, "100vw");
  assert.equal(api.iframe.style.height, "100dvh");
  assert.equal(api.iframe.style.inset, "0");
});

test("open loader follows the mobile visual viewport when the keyboard opens", () => {
  const win = fakeHost();
  win.innerWidth = 390;
  const listeners = [];
  win.visualViewport = {
    height: 640,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
  };
  const api = createLoader(win, {
    baseUrl: "https://help.example",
    inboxId: "inbox-1",
    token: "secret-token",
  });
  api.toggle();
  assert.equal(api.iframe.style.height, "640px");
  win.visualViewport.height = 400;
  listeners.find((l) => l.type === "resize")?.fn();
  assert.equal(api.iframe.style.height, "400px");
});
