import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { emptyState, reduce, visibleInQueue } from "./store.js";

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
