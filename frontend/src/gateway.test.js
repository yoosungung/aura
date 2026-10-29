import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { addConversationLabel, addInboxMember, assignConversation, connect, sendNote, sendReply, signIn, snoozeConversation, uploadAttachment, wsUrl } from "./gateway.js";

describe("gateway client", () => {
  it("reconnects websocket with a refreshed access token", async () => {
    const socks = [];
    const prev = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        socks.push(this);
      }
      close() {}
    };
    try {
      const stop = connect(
        { token: "t1", gatewayUrl: "http://gw" },
        () => {},
        { refresh: async () => ({ access_token: "t2" }) },
      );
      socks[0].onclose();
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(socks[0].url, "ws://gw/ws?token=t1");
      assert.equal(socks[1].url, "ws://gw/ws?token=t2");
      stop();
    } finally {
      globalThis.WebSocket = prev;
    }
  });

  it("builds a ws url from the http origin", () => {
    assert.equal(
      wsUrl("http://127.0.0.1:8080", "tok"),
      "ws://127.0.0.1:8080/ws?token=tok",
    );
  });

  it("posts reply with inbox and contact ids", async () => {
    const calls = [];
    await sendReply(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "user-tok",
        conversation: {
          id: "c1",
          inboxId: "i1",
          contactId: "p1",
          contactInboxId: "ci1",
        },
        content: "확인했습니다",
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({}) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/messages");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer user-tok");
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      content: "확인했습니다",
      inbox_id: "i1",
      contact_id: "p1",
      contact_inbox_id: "ci1",
    });
  });

  it("posts sign in with credentials", async () => {
    const calls = [];
    const data = await signIn(
      { gatewayUrl: "http://gw", email: "ada@acme.test", password: "s3cret" },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ access_token: "tok", user: { account_id: "acc" } }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/auth/sign_in");
    assert.equal(calls[0].opts.credentials, "include");
    assert.equal(data.access_token, "tok");
  });

  it("puts inbox members as admin", async () => {
    const calls = [];
    await addInboxMember(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        inboxId: "i1",
        userId: "u1",
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/inboxes/i1/members/u1");
    assert.equal(calls[0].opts.method, "PUT");
  });

  it("puts conversation assignee", async () => {
    const calls = [];
    await assignConversation(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        conversationId: "c1",
        assigneeId: "u1",
        expectedVersion: 1,
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ assignee_id: "u1", status: "open", version: 2 }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/assignee");
    assert.equal(calls[0].opts.method, "PUT");
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      assignee_id: "u1",
      expected_version: 1,
    });
  });

  it("posts an internal note", async () => {
    const calls = [];
    await sendNote(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        conversationId: "c1",
        content: "환불 검토",
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ private: true }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/notes");
    assert.equal(calls[0].opts.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { content: "환불 검토" });
  });

  it("puts conversation snooze until", async () => {
    const calls = [];
    await snoozeConversation(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        conversationId: "c1",
        snoozedUntil: "2026-10-30T00:00:00Z",
        expectedVersion: 1,
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ status: "snoozed" }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/snooze");
    assert.equal(calls[0].opts.method, "PUT");
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      snoozed_until: "2026-10-30T00:00:00Z",
      expected_version: 1,
    });
  });

  it("posts a conversation label name", async () => {
    const calls = [];
    await addConversationLabel(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        conversationId: "c1",
        name: "환불",
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ id: "l1", name: "환불" }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/labels");
    assert.equal(calls[0].opts.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { name: "환불" });
  });

  it("posts a conversation attachment as multipart", async () => {
    const calls = [];
    const file = new File(["pngdata"], "receipt.png", { type: "image/png" });
    await uploadAttachment(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        conversation: {
          id: "c1",
          inboxId: "i1",
          contactId: "p1",
          contactInboxId: "ci1",
        },
        file,
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ message_id: "m2", attachments: [] }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/attachments");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer tok");
    assert.ok(calls[0].opts.body instanceof FormData);
    assert.equal(calls[0].opts.body.get("inbox_id"), "i1");
    assert.equal(calls[0].opts.body.get("file").name, "receipt.png");
  });
});
