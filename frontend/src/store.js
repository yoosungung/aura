export const emptyState = {
  conversations: [],
  selectedId: null,
  messages: {},
};

export function fixtureState() {
  return {
    conversations: [
      {
        id: "c1",
        inboxId: "i1",
        contactId: "p1",
        contactInboxId: "ci1",
        lastContent: "결제 오류",
        unread: 1,
        version: 1,
      },
    ],
    selectedId: null,
    messages: {
      c1: [{ id: "m1", content: "결제 오류", senderType: "Contact" }],
    },
  };
}

export function parseSession(search, env = {}) {
  const p = new URLSearchParams(search);
  return {
    accountId: p.get("account_id") || env.VITE_ACCOUNT_ID || "",
    token: p.get("token") || env.VITE_TOKEN || "",
    gatewayUrl: p.get("gateway") || env.VITE_GATEWAY_URL || "",
    fixture: p.get("fixture") === "1",
  };
}

export function reduce(state, action) {
  if (action.type === "select") {
    return {
      ...state,
      selectedId: action.id,
      conversations: state.conversations.map((c) =>
        c.id === action.id ? { ...c, unread: 0 } : c,
      ),
    };
  }
  if (action.type === "assigned") {
    return {
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === action.conversationId
          ? { ...c, assigneeId: action.assigneeId, status: action.status, version: action.version }
          : c,
      ),
    };
  }
  if (action.type === "realtime") {
    return applyRealtime(state, action.event);
  }
  return state;
}

function applyRealtime(state, event) {
  if (!event || event.event !== "message.created") {
    return state;
  }
  const convId = event.conversation_id;
  const env = event.message || {};
  const payload = env.payload || {};
  const msgId = env.id;
  const existing = state.messages[convId] || [];
  if (msgId && existing.some((m) => m.id === msgId)) {
    return state;
  }
  const content = payload.content ?? "";
  const msg = { id: msgId, content, senderType: payload.sender_type };
  const selected = state.selectedId === convId;
  const prev = state.conversations.find((c) => c.id === convId);
  const nextConv = {
    id: convId,
    inboxId: event.inbox_id,
    contactId: payload.contact_id,
    contactInboxId: payload.contact_inbox_id,
    lastContent: content,
    unread: selected ? 0 : (prev?.unread ?? 0) + 1,
  };
  return {
    ...state,
    messages: { ...state.messages, [convId]: [...existing, msg] },
    conversations: [nextConv, ...state.conversations.filter((c) => c.id !== convId)],
  };
}
