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

export function conversationsFromAPI(rows) {
  return (rows || []).map((c) => ({
    id: c.id,
    inboxId: c.inbox_id,
    contactId: c.contact_id,
    contactInboxId: c.contact_inbox_id,
    assigneeId: c.assignee_id,
    status: c.status,
    version: c.version,
    snoozedUntil: c.snoozed_until,
    lastContent: c.last_content,
    unread: 0,
    labels: c.labels || [],
  }));
}

export function messagesFromAPI(rows) {
  return (rows || []).map((m) => ({
    id: m.id,
    content: m.content,
    senderType: m.sender_type,
    private: m.private,
    attachments: m.attachments || [],
  }));
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

export function visibleInQueue(c, now = Date.now()) {
  if (c.status === "resolved") {
    return false;
  }
  if (c.status !== "snoozed") {
    return true;
  }
  const until = Date.parse(c.snoozedUntil || "");
  return Number.isFinite(until) && until <= now;
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
  if (action.type === "labeled") {
    return {
      ...state,
      conversations: state.conversations.map((c) => {
        if (c.id !== action.conversationId) {
          return c;
        }
        const labels = c.labels || [];
        const next = action.label;
        if (next?.id && labels.some((l) => l.id === next.id)) {
          return c;
        }
        return { ...c, labels: [...labels, next] };
      }),
    };
  }
  if (action.type === "snoozed") {
    return {
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === action.conversationId
          ? { ...c, status: action.status, snoozedUntil: action.snoozedUntil, version: action.version }
          : c,
      ),
    };
  }
  if (action.type === "unlabeled") {
    return {
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === action.conversationId
          ? { ...c, labels: (c.labels || []).filter((l) => l.id !== action.labelId) }
          : c,
      ),
    };
  }
  if (action.type === "resolved") {
    return {
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === action.conversationId ? { ...c, status: "resolved", version: action.version } : c,
      ),
      selectedId: state.selectedId === action.conversationId ? null : state.selectedId,
    };
  }
  if (action.type === "hydrate") {
    return {
      ...state,
      conversations: action.conversations || state.conversations,
      messages: action.messages ? { ...state.messages, ...action.messages } : state.messages,
    };
  }
  if (action.type === "realtime") {
    return applyRealtime(state, action.event);
  }
  return state;
}

function applyRealtime(state, event) {
  if (!event) {
    return state;
  }
  if (event.event === "conversation.status_changed" || event.event === "status_changed") {
    const convId = event.conversation_id;
    const status = event.status || event.payload?.new_status;
    const version = event.version;
    return {
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === convId ? { ...c, status, version: version || c.version } : c,
      ),
      selectedId: status === "resolved" && state.selectedId === convId ? null : state.selectedId,
    };
  }
  if (event.event !== "message.created") {
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
  const isPrivate = payload.private === true;
  const msg = {
    id: msgId,
    content,
    senderType: payload.sender_type,
    private: isPrivate,
    attachments: payload.attachments || [],
  };
  const selected = state.selectedId === convId;
  const prev = state.conversations.find((c) => c.id === convId);
  if (isPrivate) {
    return {
      ...state,
      messages: { ...state.messages, [convId]: [...existing, msg] },
    };
  }
  const nextConv = {
    id: convId,
    inboxId: event.inbox_id,
    contactId: payload.contact_id,
    contactInboxId: payload.contact_inbox_id,
    lastContent: content,
    unread: selected ? 0 : (prev?.unread ?? 0) + 1,
    labels: prev?.labels,
  };
  return {
    ...state,
    messages: { ...state.messages, [convId]: [...existing, msg] },
    conversations: [nextConv, ...state.conversations.filter((c) => c.id !== convId)],
  };
}
