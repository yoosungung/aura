import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sendReply, signIn, wsUrl } from "./gateway.js";

describe("gateway client", () => {
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
});
