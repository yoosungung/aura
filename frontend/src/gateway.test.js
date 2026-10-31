import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { addConversationLabel, addInboxMember, assignConversation, connect, createCanned, deleteArticle, deleteMCP, deleteSkill, deleteWebhook, executeMacro, getInbox, listCanned, listConversations, listContacts, removeConversationLabel, resolveConversation, rotateHmac, sendNote, sendReply, signIn, signOut, snoozeConversation, updateInbox, uploadAttachment, wsUrl } from "./gateway.js";

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

  it("retries once after a single-flight refresh on 401", async () => {
    const calls = [];
    let refreshes = 0;
    const sessions = [];
    const conv = { id: "c1", inboxId: "i1", contactId: "p1", contactInboxId: "ci1" };
    const refresh = async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { access_token: "new" };
    };
    const fetchImpl = async (_url, opts) => {
      calls.push(opts);
      if (opts.headers.Authorization === "Bearer old") {
        return { status: 401, ok: false };
      }
      return { ok: true, json: async () => ({}) };
    };
    const req = {
      gatewayUrl: "http://gw",
      accountId: "acc",
      token: "old",
      conversation: conv,
      refresh,
      onSessionUpdate: (next) => sessions.push(next),
    };
    await Promise.all([
      sendReply({ ...req, content: "하나" }, fetchImpl),
      sendReply({ ...req, content: "둘" }, fetchImpl),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(sessions[0].token, "new");
    assert.equal(calls.filter((c) => c.headers.Authorization === "Bearer new").length, 2);
  });

  it("notifies the session when websocket refresh rotates the token", async () => {
    const socks = [];
    const sessions = [];
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
        {
          refresh: async () => ({ access_token: "t2" }),
          onSessionUpdate: (next) => sessions.push(next),
        },
      );
      socks[0].onclose();
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(sessions[0].token, "t2");
      stop();
    } finally {
      globalThis.WebSocket = prev;
    }
  });

  it("sends typing frames on the live socket", () => {
    const socks = [];
    const prev = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        socks.push(this);
      }
      send(data) {
        this.sent.push(data);
      }
      close() {}
    };
    try {
      const stop = connect({ token: "t1", gatewayUrl: "http://gw" }, () => {});
      stop.send({ type: "typing", conversation_id: "c1", is_typing: true });
      assert.equal(JSON.parse(socks[0].sent[0]).type, "typing");
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

  it("signs out by deleting the session cookie", async () => {
    const calls = [];
    await signOut({ gatewayUrl: "http://gw" }, async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    });
    assert.equal(calls[0].url, "http://gw/auth/sign_out");
    assert.equal(calls[0].opts.method, "DELETE");
    assert.equal(calls[0].opts.credentials, "include");
  });

  it("lists contacts for the queue profile", async () => {
    const listed = await listContacts(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok" },
      async () => ({ ok: true, json: async () => ({ contacts: [{ id: "p1", name: "홍길동" }] }) }),
    );
    assert.equal(listed.contacts[0].name, "홍길동");
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

  it("gets and rotates inbox hmac secret", async () => {
    const got = await getInbox(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", inboxId: "i1" },
      async (url) => ({ ok: true, json: async () => ({ hmac_secret: "secret" }) }),
    );
    assert.equal(got.hmac_secret, "secret");
    const calls = [];
    const rotated = await rotateHmac(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", inboxId: "i1" },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ hmac_secret: "newsecret" }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/inboxes/i1/hmac/rotate");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(rotated.hmac_secret, "newsecret");
  });

  it("patches inbox greeting and hours", async () => {
    const calls = [];
    const got = await updateInbox(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        inboxId: "i1",
        greetingMessage: "부재중",
        businessHoursEnabled: true,
        businessHours: { timezone: "Asia/Seoul" },
      },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ greeting_message: "부재중" }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/inboxes/i1");
    assert.equal(calls[0].opts.method, "PATCH");
    assert.equal(JSON.parse(calls[0].opts.body).greeting_message, "부재중");
    assert.equal(got.greeting_message, "부재중");
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

  it("deletes a conversation label and lists conversations", async () => {
    const calls = [];
    await removeConversationLabel(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", conversationId: "c1", labelId: "l1" },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/labels/l1");
    assert.equal(calls[0].opts.method, "DELETE");
    const listed = await listConversations(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok" },
      async (url) => ({ ok: true, json: async () => ({ conversations: [{ id: "c1" }] }) }),
    );
    assert.equal(listed.conversations[0].id, "c1");
  });

  it("lists canned responses and executes a macro", async () => {
    const canned = await listCanned(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok" },
      async (url) => ({
        ok: true,
        json: async () => ({ canned_responses: [{ id: "r1", short_code: "인사", content: "안녕하세요" }] }),
      }),
    );
    assert.equal(canned.canned_responses[0].short_code, "인사");
    const calls = [];
    await executeMacro(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", conversationId: "c1", macroId: "m1" },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ status: "resolved", version: 2, labels: [], messages: [] }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/macros/m1/execute");
    assert.equal(calls[0].opts.method, "POST");
    const created = await createCanned(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", shortCode: "인사", content: "안녕하세요" },
      async (_url, opts) => ({
        ok: true,
        json: async () => JSON.parse(opts.body),
      }),
    );
    assert.equal(created.short_code, "인사");
  });

  it("puts conversation resolved status", async () => {
    const calls = [];
    await resolveConversation(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", conversationId: "c1", expectedVersion: 1 },
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ status: "resolved", version: 2 }) };
      },
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/conversations/c1/status");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { new_status: "resolved", expected_version: 1 });
    const pending = [];
    await resolveConversation(
      {
        gatewayUrl: "http://gw",
        accountId: "acc",
        token: "tok",
        conversationId: "c1",
        expectedVersion: 1,
        newStatus: "pending",
      },
      async (url, opts) => {
        pending.push({ url, opts });
        return { ok: true, json: async () => ({ status: "pending", version: 2 }) };
      },
    );
    assert.deepEqual(JSON.parse(pending[0].opts.body), { new_status: "pending", expected_version: 1 });
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

  it("deletes webhooks, mcp servers, agent skills, and articles", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await deleteWebhook(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", webhook_id: "wh1" },
      fetchImpl,
    );
    await deleteMCP(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", mcp_server_id: "m1" },
      fetchImpl,
    );
    await deleteSkill(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", skill_id: "s1" },
      fetchImpl,
    );
    await deleteArticle(
      { gatewayUrl: "http://gw", accountId: "acc", token: "tok", article_id: "a1" },
      fetchImpl,
    );
    assert.equal(calls[0].url, "http://gw/api/v1/accounts/acc/webhooks/wh1");
    assert.equal(calls[0].opts.method, "DELETE");
    assert.equal(calls[1].url, "http://gw/api/v1/accounts/acc/mcp_servers/m1");
    assert.equal(calls[1].opts.method, "DELETE");
    assert.equal(calls[2].url, "http://gw/api/v1/accounts/acc/agent_skills/s1");
    assert.equal(calls[2].opts.method, "DELETE");
    assert.equal(calls[3].url, "http://gw/api/v1/accounts/acc/articles/a1");
    assert.equal(calls[3].opts.method, "DELETE");
  });
});
