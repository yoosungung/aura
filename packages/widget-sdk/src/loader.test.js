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
        contentWindow: {
          postMessage(data, target) {
            el.sent.push({ data, target });
          },
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

test("javascript baseUrl does not create an iframe", () => {
  const win = fakeHost();
  assert.throws(() =>
    createLoader(win, { baseUrl: "javascript:alert(1)", inboxId: "i", token: "t" }),
  );
  assert.equal(win.document.body.children.length, 0);
});
