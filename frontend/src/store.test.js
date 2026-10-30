import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  channelLabel,
  conversationsFromAPI,
  emptyState,
  messagesFromAPI,
  reduce,
  visibleInQueue,
} from "./store.js";

function created({ id, conv, content, contact = "p1", inbox = "i1" }) {
  return {
    type: "event",
    event: "message.created",
    inbox_id: inbox,
    conversation_id: conv,
    message: {
      id,
      payload: {
        content,
        sender_type: "Contact",
        contact_id: contact,
        contact_inbox_id: "ci1",
      },
    },
  };
}

describe("reduce realtime", () => {
  it("upserts a queue card and appends the thread", () => {
    const s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    assert.equal(s.conversations.length, 1);
    assert.equal(s.conversations[0].lastContent, "결제 오류");
    assert.equal(s.conversations[0].unread, 1);
    assert.ok(s.conversations[0].lastActivityAt);
    assert.equal(s.messages.c1[0].content, "결제 오류");
  });

  it("does not duplicate the same message id", () => {
    const event = created({ id: "m1", conv: "c1", content: "hi" });
    const s1 = reduce(emptyState, { type: "realtime", event });
    const s2 = reduce(s1, { type: "realtime", event });
    assert.equal(s2.messages.c1.length, 1);
    assert.equal(s2.conversations[0].unread, 1);
  });

  it("moves the latest conversation to the top", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "one" }),
    });
    s = reduce(s, {
      type: "realtime",
      event: created({ id: "m2", conv: "c2", content: "two" }),
    });
    assert.deepEqual(
      s.conversations.map((c) => c.id),
      ["c2", "c1"],
    );
  });

  it("clears unread on select", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "hi" }),
    });
    s = reduce(s, { type: "select", id: "c1" });
    assert.equal(s.selectedId, "c1");
    assert.equal(s.conversations[0].unread, 0);
  });

  it("keeps private notes off the queue card", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    s = reduce(s, {
      type: "realtime",
      event: {
        type: "event",
        event: "message.created",
        inbox_id: "i1",
        conversation_id: "c1",
        message: {
          id: "n1",
          payload: { content: "내부 확인", sender_type: "User", private: true },
        },
      },
    });
    assert.equal(s.conversations[0].lastContent, "결제 오류");
    assert.equal(s.conversations[0].unread, 1);
    assert.equal(s.messages.c1[1].private, true);
  });

  it("hides snoozed tickets until the wake time", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    assert.equal(
      visibleInQueue({ status: "snoozed", snoozedUntil: "2026-10-29T13:00:00Z" }, now),
      false,
    );
    assert.equal(
      visibleInQueue({ status: "snoozed", snoozedUntil: "2026-10-29T11:00:00Z" }, now),
      true,
    );
    assert.equal(visibleInQueue({ status: "open" }, now), true);
    assert.equal(visibleInQueue({ status: "pending" }, now), true);
    assert.equal(visibleInQueue({ status: "resolved" }, now), false);
  });

  it("keeps a pending ticket selected in the queue", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    s = reduce(s, { type: "select", id: "c1" });
    s = reduce(s, { type: "resolved", conversationId: "c1", status: "pending", version: 2 });
    assert.equal(s.conversations[0].status, "pending");
    assert.equal(s.selectedId, "c1");
    assert.equal(visibleInQueue(s.conversations[0]), true);
  });

  it("applies status_changed and drops resolved from the thread", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    s = reduce(s, { type: "select", id: "c1" });
    s = reduce(s, {
      type: "realtime",
      event: { event: "conversation.status_changed", conversation_id: "c1", status: "resolved", version: 2 },
    });
    assert.equal(s.conversations[0].status, "resolved");
    assert.equal(s.selectedId, null);
  });

  it("appends a label onto the conversation", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    s = reduce(s, {
      type: "labeled",
      conversationId: "c1",
      label: { id: "l1", name: "환불" },
    });
    assert.deepEqual(s.conversations[0].labels, [{ id: "l1", name: "환불" }]);
  });

  it("keeps labels when a later public message arrives", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    s = reduce(s, {
      type: "labeled",
      conversationId: "c1",
      label: { id: "l1", name: "환불" },
    });
    s = reduce(s, {
      type: "realtime",
      event: created({ id: "m2", conv: "c1", content: "확인 부탁" }),
    });
    assert.deepEqual(s.conversations[0].labels, [{ id: "l1", name: "환불" }]);
  });

  it("keeps ticket metadata when a later public message arrives", () => {
    let s = reduce(emptyState, {
      type: "realtime",
      event: created({ id: "m1", conv: "c1", content: "결제 오류" }),
    });
    s = {
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === "c1"
          ? {
              ...c,
              status: "open",
              version: 3,
              assigneeId: "user-1",
              snoozedUntil: "2026-10-30T09:00:00Z",
              slaBreached: true,
            }
          : c,
      ),
    };
    s = reduce(s, {
      type: "realtime",
      event: created({ id: "m2", conv: "c1", content: "확인 부탁" }),
    });
    const card = s.conversations[0];
    assert.equal(card.lastContent, "확인 부탁");
    assert.equal(card.status, "open");
    assert.equal(card.version, 3);
    assert.equal(card.assigneeId, "user-1");
    assert.equal(card.snoozedUntil, "2026-10-30T09:00:00Z");
    assert.equal(card.slaBreached, true);
  });

  it("keeps attachment urls on the thread message", () => {
    const s = reduce(emptyState, {
      type: "realtime",
      event: {
        type: "event",
        event: "message.created",
        inbox_id: "i1",
        conversation_id: "c1",
        message: {
          id: "m2",
          payload: {
            content: "receipt.png",
            sender_type: "User",
            contact_id: "p1",
            contact_inbox_id: "ci1",
            attachments: [
              { id: "a1", file_type: "image", external_url: "http://filer/receipt.png", file_size: 7 },
            ],
          },
        },
      },
    });
    assert.equal(s.messages.c1[0].attachments[0].external_url, "http://filer/receipt.png");
  });
});

describe("conversationsFromAPI", () => {
  it("maps sla_breached onto the queue card", () => {
    const rows = conversationsFromAPI([{ id: "c1", last_content: "지연", sla_breached: true }]);
    assert.equal(rows[0].slaBreached, true);
  });

  it("maps display_id and channel_type onto the queue card", () => {
    const rows = conversationsFromAPI([
      { id: "c1", last_content: "지연", display_id: 1042, channel_type: "web" },
    ]);
    assert.equal(rows[0].displayId, 1042);
    assert.equal(rows[0].channel, "web");
  });

  it("maps contact name last activity and sla dues", () => {
    const rows = conversationsFromAPI([
      {
        id: "c1",
        contact_name: "홍길동",
        contact_email: "ada@acme.test",
        last_activity_at: "2026-10-30T05:00:00Z",
        applied_slas: { frt_due_at: "2026-10-30T06:00:00Z" },
      },
    ]);
    assert.equal(rows[0].contactName, "홍길동");
    assert.equal(rows[0].contactEmail, "ada@acme.test");
    assert.equal(rows[0].lastActivityAt, "2026-10-30T05:00:00Z");
    assert.equal(rows[0].appliedSlas.frtDueAt, "2026-10-30T06:00:00Z");
  });
});

describe("channelLabel", () => {
  it("maps channel_type to the queue badge", () => {
    assert.equal(channelLabel("web"), "Web");
    assert.equal(channelLabel("kakao"), "Kakao");
    assert.equal(channelLabel("email"), "Email");
  });
});

describe("messagesFromAPI", () => {
  it("maps created_at onto the timeline", () => {
    const rows = messagesFromAPI([{ id: "m1", content: "hi", sender_type: "Contact", created_at: "2026-10-30T05:20:00Z" }]);
    assert.equal(rows[0].createdAt, "2026-10-30T05:20:00Z");
  });
});
