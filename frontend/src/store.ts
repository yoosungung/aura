export type TicketLabel = {
  id: string;
  name?: string;
};

export type AppliedSlas = {
  frtDueAt?: string;
  nrtDueAt?: string;
  rtDueAt?: string;
};

export type Attachment = {
  id?: string;
  file_type?: string;
  file_name?: string;
  filename?: string;
  content_type?: string;
  external_url?: string;
  file_size?: number;
};

export type Conversation = {
  id: string;
  inboxId?: string;
  contactId?: string;
  contactInboxId?: string;
  assigneeId?: string;
  status?: string;
  version?: number;
  snoozedUntil?: string;
  lastContent?: string;
  unread?: number;
  labels?: TicketLabel[];
  slaBreached?: boolean;
  displayId?: number | string;
  channel?: string;
  contactName?: string;
  contactEmail?: string;
  lastActivityAt?: string;
  appliedSlas?: AppliedSlas;
};

export type Message = {
  id?: string;
  content?: string;
  senderType?: string;
  contentType?: string;
  private?: boolean;
  createdAt?: string;
  attachments?: Attachment[];
  status?: "sending" | "failed";
};

export type TypingState = {
  userType?: string;
  userId?: string;
};

export type WorkspaceState = {
  conversations: Conversation[];
  selectedId: string | null;
  messages: Record<string, Message[]>;
  typing: Record<string, TypingState>;
};

export type Session = {
  accountId: string;
  token: string;
  gatewayUrl: string;
  fixture?: boolean;
  role?: string;
  inboxIds?: string[];
  userId?: string;
  name?: string;
  email?: string;
  availabilityStatus?: string;
};

export type ToolApproval = {
  kind: "tool_approval";
  execution_id: string;
  tool_name?: string;
  summary?: string;
};

export type ConversationRow = {
  id: string;
  inbox_id?: string;
  contact_id?: string;
  contact_inbox_id?: string;
  assignee_id?: string;
  status?: string;
  version?: number;
  snoozed_until?: string;
  last_content?: string;
  labels?: TicketLabel[];
  sla_breached?: boolean;
  display_id?: number | string;
  channel_type?: string;
  channel?: string;
  contact_name?: string;
  contact_email?: string;
  last_activity_at?: string;
  applied_slas?: {
    frt_due_at?: string;
    nrt_due_at?: string;
    rt_due_at?: string;
  };
};

export type MessageRow = {
  id?: string;
  content?: string;
  sender_type?: string;
  content_type?: string;
  private?: boolean;
  created_at?: string;
  attachments?: Attachment[];
};

export type RealtimeEvent = {
  type?: string;
  event?: string;
  conversation_id?: string;
  inbox_id?: string;
  is_typing?: boolean;
  user_id?: string;
  user_type?: string;
  status?: string;
  version?: number;
  payload?: { new_status?: string };
  message?: {
    id?: string;
    created_at?: string;
    payload?: {
      content?: string;
      sender_type?: string;
      private?: boolean;
      content_type?: string;
      created_at?: string;
      contact_id?: string;
      contact_inbox_id?: string;
      attachments?: Attachment[];
    };
  };
};

export type ContactHint = {
  name?: string;
  email?: string;
};

export type Action =
  | { type: "select"; id: string | null }
  | { type: "assigned"; conversationId: string; assigneeId?: string; status?: string; version?: number }
  | { type: "labeled"; conversationId: string; label?: TicketLabel }
  | { type: "snoozed"; conversationId: string; status?: string; snoozedUntil?: string; version?: number }
  | { type: "unlabeled"; conversationId: string; labelId: string }
  | { type: "resolved"; conversationId: string; status?: string; version?: number }
  | { type: "send"; conversationId: string; message: Message }
  | { type: "sent"; conversationId: string; id: string; messageId?: string }
  | { type: "sendFailed"; conversationId: string; id: string }
  | { type: "retry"; conversationId: string; id: string }
  | { type: "hydrate"; conversations?: Conversation[]; messages?: Record<string, Message[]> }
  | { type: "contacts"; contacts?: Record<string, ContactHint> }
  | { type: "realtime"; event?: RealtimeEvent };

export type SessionEnv = {
  VITE_ACCOUNT_ID?: string;
  VITE_TOKEN?: string;
  VITE_GATEWAY_URL?: string;
};

export const emptyState: WorkspaceState = {
  conversations: [],
  selectedId: null,
  messages: {},
  typing: {},
};

export function fixtureState(): WorkspaceState {
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
    typing: {},
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

export const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  kakao: "Kakao",
  email: "Email",
  social: "Social",
};

export function channelLabel(channel?: string | null) {
  return CHANNEL_LABELS[channel || ""] || channel || "";
}

export function conversationsFromAPI(rows?: ConversationRow[] | null): Conversation[] {
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

export function messagesFromAPI(rows?: MessageRow[] | null): Message[] {
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

export function parseApproval(content?: string | null): ToolApproval | null {
  try {
    const data: unknown = JSON.parse(content || "");
    if (
      data &&
      typeof data === "object" &&
      "kind" in data &&
      data.kind === "tool_approval" &&
      "execution_id" in data &&
      data.execution_id
    ) {
      return data as ToolApproval;
    }
  } catch {
    return null;
  }
  return null;
}

export function relativeTime(iso?: string | null, now = Date.now()) {
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

export function formatClock(iso?: string | null) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function slaRemain(iso?: string | null, now = Date.now()) {
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

export function kakaoSessionLabel(iso?: string | null, now = Date.now()) {
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

export function parseSession(search: string, env: SessionEnv = {}): Session {
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

export function visibleInQueue(c: Pick<Conversation, "status" | "snoozedUntil">, now = Date.now()) {
  if (c.status === "resolved") {
    return false;
  }
  if (c.status !== "snoozed") {
    return true;
  }
  const until = Date.parse(c.snoozedUntil || "");
  return Number.isFinite(until) && until <= now;
}

export function reduce(state: WorkspaceState, action: Action): WorkspaceState {
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
        return next ? { ...c, labels: [...labels, next] } : c;
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
        const p = c.contactId ? book[c.contactId] : undefined;
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

function applyRealtime(state: WorkspaceState, event?: RealtimeEvent): WorkspaceState {
  if (!event) {
    return state;
  }
  if (event.event === "typing") {
    const convId = event.conversation_id;
    if (!convId) {
      return state;
    }
    const typing = { ...(state.typing || {}) };
    if (event.is_typing) {
      typing[convId] = { userType: event.user_type, userId: event.user_id };
    } else {
      delete typing[convId];
    }
    return { ...state, typing };
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
  const convId = event.conversation_id ?? "";
  const env = event.message || {};
  const payload = env.payload || {};
  const msgId = env.id;
  const existing = state.messages[convId] || [];
  if (msgId && existing.some((m) => m.id === msgId)) {
    return state;
  }
  const content = payload.content ?? "";
  const isPrivate = payload.private === true;
  const msg: Message = {
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
  const nextConv: Conversation = {
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

function isLocalMessage(m: Message) {
  return typeof m.id === "string" && m.id.startsWith("pending-");
}

function patchMessage(state: WorkspaceState, conversationId: string, id: string, patch: Partial<Message>) {
  const existing = state.messages[conversationId] || [];
  return {
    ...state,
    messages: {
      ...state.messages,
      [conversationId]: existing.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    },
  };
}
