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
        contactName: "홍길동",
        lastContent: "결제 오류",
        unread: 1,
        version: 1,
      },
    ],
    selectedId: null,
    messages: {
      c1: [
        {
          id: "m1",
          content: "결제 오류",
          senderType: "Contact",
          attachments: [
            {
              id: "a0",
              file_type: "image",
              file_name: "shot.png",
              external_url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              file_size: 70,
            },
          ],
        },
      ],
    },
  };
}

export const CHANNEL_LABELS = {
  web: "Web",
  kakao: "Kakao",
  email: "Email",
  social: "Social",
};

export function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || channel || "";
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
    slaBreached: !!c.sla_breached,
    displayId: c.display_id,
    channel: c.channel_type || c.channel,
    contactName: c.contact_name,
    contactEmail: c.contact_email,
    lastActivityAt: c.last_activity_at,
    appliedSlas: c.applied_slas
      ? {
          frtDueAt: c.applied_slas.frt_due_at,
          nrtDueAt: c.applied_slas.nrt_due_at,
          rtDueAt: c.applied_slas.rt_due_at,
        }
      : undefined,
  }));
}

export function messagesFromAPI(rows) {
  return (rows || []).map((m) => ({
    id: m.id,
    content: m.content,
    senderType: m.sender_type,
    contentType: m.content_type,
    private: m.private,
    createdAt: m.created_at,
    attachments: m.attachments || [],
  }));
}

export function parseApproval(content) {
  try {
    const data = JSON.parse(content || "");
    if (data?.kind === "tool_approval" && data.execution_id) {
      return data;
    }
  } catch {
    return null;
  }
  return null;
}

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) {
    return "";
  }
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) {
    return "방금";
  }
  if (mins < 60) {
    return `${mins}분 전`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours}시간 전`;
  }
  return `${Math.round(hours / 24)}일 전`;
}

export function formatClock(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function slaRemain(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) {
    return "";
  }
  const left = t - now;
  if (left <= 0) {
    return "위반";
  }
  const mins = Math.round(left / 60_000);
  if (mins < 60) {
    return `${mins}분 남음`;
  }
  return `${Math.round(mins / 60)}시간 남음`;
}

export function kakaoSessionLabel(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) {
    return "";
  }
  const left = t + 30 * 86_400_000 - now;
  if (left <= 0) {
    return "세션 만료";
  }
  return `세션 ${Math.max(1, Math.ceil(left / 86_400_000))}일 남음`;
}

export function parseSession(search, env = {}) {
  const p = new URLSearchParams(search);
  const fixture = p.get("fixture") === "1";
  return {
    accountId: p.get("account_id") || env.VITE_ACCOUNT_ID || (fixture ? "acc" : ""),
    token: p.get("token") || env.VITE_TOKEN || "",
    gatewayUrl: p.get("gateway") || env.VITE_GATEWAY_URL || "",
    fixture,
    ...(fixture
      ? { role: "administrator", inboxIds: ["i1", "i2"], userId: "user-1", name: "Ada" }
      : {}),
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
    const status = action.status || "resolved";
    return {
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === action.conversationId ? { ...c, status, version: action.version } : c,
      ),
      selectedId:
        status === "resolved" && state.selectedId === action.conversationId ? null : state.selectedId,
    };
  }
  if (action.type === "send") {
    const convId = action.conversationId;
    const existing = state.messages[convId] || [];
    const msg = action.message;
    return {
      ...state,
      messages: { ...state.messages, [convId]: [...existing, msg] },
      conversations: state.conversations.map((c) =>
        c.id === convId && !msg.private
          ? { ...c, lastContent: msg.content, lastActivityAt: msg.createdAt || c.lastActivityAt }
          : c,
      ),
    };
  }
  if (action.type === "sent") {
    return patchMessage(state, action.conversationId, action.id, {
      id: action.messageId || action.id,
      status: undefined,
    });
  }
  if (action.type === "sendFailed") {
    return patchMessage(state, action.conversationId, action.id, { status: "failed" });
  }
  if (action.type === "retry") {
    return patchMessage(state, action.conversationId, action.id, { status: "sending" });
  }
  if (action.type === "hydrate") {
    return {
      ...state,
      conversations: action.conversations || state.conversations,
      messages: action.messages ? { ...state.messages, ...action.messages } : state.messages,
    };
  }
  if (action.type === "contacts") {
    const book = action.contacts || {};
    return {
      ...state,
      conversations: state.conversations.map((c) => {
        const p = book[c.contactId];
        if (!p) {
          return c;
        }
        return {
          ...c,
          contactName: c.contactName || p.name,
          contactEmail: c.contactEmail || p.email,
        };
      }),
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
    contentType: payload.content_type,
    private: isPrivate,
    createdAt: payload.created_at || env.created_at,
    attachments: payload.attachments || [],
  };
  const localIdx = existing.findIndex(
    (m) =>
      isLocalMessage(m) &&
      m.content === content &&
      Boolean(m.private) === isPrivate &&
      (m.senderType || "User") === (payload.sender_type || "User"),
  );
  const thread =
    localIdx >= 0
      ? existing.map((m, i) => (i === localIdx ? { ...m, ...msg, status: undefined } : m))
      : [...existing, msg];
  const selected = state.selectedId === convId;
  const prev = state.conversations.find((c) => c.id === convId);
  if (isPrivate) {
    return {
      ...state,
      messages: { ...state.messages, [convId]: thread },
    };
  }
  const nextConv = {
    ...prev,
    id: convId,
    inboxId: event.inbox_id || prev?.inboxId,
    contactId: payload.contact_id || prev?.contactId,
    contactInboxId: payload.contact_inbox_id || prev?.contactInboxId,
    lastContent: content,
    lastActivityAt: msg.createdAt || new Date().toISOString(),
    unread: selected ? 0 : (prev?.unread ?? 0) + 1,
    labels: prev?.labels || [],
  };
  return {
    ...state,
    messages: { ...state.messages, [convId]: thread },
    conversations: [nextConv, ...state.conversations.filter((c) => c.id !== convId)],
  };
}

function isLocalMessage(m) {
  return typeof m?.id === "string" && m.id.startsWith("pending-");
}

function patchMessage(state, conversationId, id, patch) {
  const existing = state.messages[conversationId] || [];
  return {
    ...state,
    messages: {
      ...state.messages,
      [conversationId]: existing.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    },
  };
}
