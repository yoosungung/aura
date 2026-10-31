import type { Conversation, RealtimeEvent } from "./store.js";

export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export type RefreshResult = {
  access_token?: string;
  user?: any;
};

export type SessionUpdate = {
  token: string;
  access_token: string;
  user?: any;
};

export type RefreshFn = (req: { gatewayUrl?: string }) => Promise<RefreshResult | null | undefined>;

export type AuthedReq = {
  gatewayUrl?: string;
  accountId?: string;
  token?: string;
  refresh?: RefreshFn;
  onSessionUpdate?: (next: SessionUpdate) => void;
};

export type ClientReq = AuthedReq & {
  conversation?: Conversation;
  conversationId?: string;
  content?: string;
  email?: string;
  password?: string;
  inboxId?: string;
  userId?: string;
  assigneeId?: string;
  expectedVersion?: number;
  labelId?: string;
  contactId?: string;
  executionId?: string;
  newStatus?: string;
  name?: string;
  snoozedUntil?: string;
  file?: Blob;
  greetingMessage?: string;
  businessHoursEnabled?: boolean;
  businessHours?: Record<string, unknown>;
  shortCode?: string;
  visibility?: string;
  actions?: unknown;
  macroId?: string;
  url?: string;
  subscriptions?: string[];
  webhook_id?: string;
  auth_header?: string;
  allowed_tools?: unknown;
  high_risk_tools?: unknown;
  mcp_server_id?: string;
  description?: string;
  body?: string;
  skill_id?: string;
  title?: string;
  slug?: string;
  published?: boolean;
  article_id?: string;
  canned_id?: string;
};

export type StopHandle = (() => void) & { send: (payload: unknown) => void };

type AuthHooks = {
  refresh?: RefreshFn;
  onSessionUpdate?: (next: SessionUpdate) => void;
};

type ConnectSession = {
  token?: string;
  gatewayUrl?: string;
  refresh?: RefreshFn;
};

type ConnectDeps = {
  refresh?: RefreshFn;
  onSessionUpdate?: (next: SessionUpdate) => void;
};

const asFetch = fetch as FetchImpl;

export function wsUrl(gatewayUrl: string | undefined, token: string) {
  const http = gatewayUrl || (typeof location === "undefined" ? "" : location.origin);
  return `${http.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

let refreshInFlight: Promise<RefreshResult | null | undefined> | null = null;

export async function requestWithAuth(
  req: AuthedReq | undefined,
  url: string,
  init: RequestInit = {},
  fetchImpl: FetchImpl = asFetch,
) {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) || {}) };
  if (req?.token && !headers.Authorization) {
    headers.Authorization = `Bearer ${req.token}`;
  }
  const res = await fetchImpl(url, { ...init, headers });
  const refresh = req?.refresh || authHooks.refresh;
  const onSessionUpdate = req?.onSessionUpdate || authHooks.onSessionUpdate;
  if (res.status !== 401 || typeof refresh !== "function") {
    return res;
  }
  if (!refreshInFlight) {
    refreshInFlight = Promise.resolve(refresh({ gatewayUrl: req?.gatewayUrl })).finally(() => {
      refreshInFlight = null;
    });
  }
  const data = await refreshInFlight;
  const next = data?.access_token;
  if (!next) {
    return res;
  }
  onSessionUpdate?.({ token: next, access_token: next, user: data?.user });
  return fetchImpl(url, { ...init, headers: { ...headers, Authorization: `Bearer ${next}` } });
}

function authed(req: AuthedReq, fetchImpl: FetchImpl): FetchImpl {
  return (url, init) => requestWithAuth(req, url, init || {}, fetchImpl);
}

let authHooks: AuthHooks = {};

export function bindAuth(hooks?: AuthHooks | null) {
  authHooks = hooks || {};
}

export function connect(
  session: ConnectSession,
  onEvent: (event: RealtimeEvent) => void,
  deps: ConnectDeps = {},
): StopHandle {
  if (!session.token || typeof WebSocket === "undefined") {
    const noop = (() => {}) as StopHandle;
    noop.send = () => {};
    return noop;
  }
  let closed = false;
  let socket: WebSocket | undefined;
  let token = session.token;
  const refresh = deps.refresh || session.refresh;
  function send(payload: unknown) {
    if (!socket || (socket.readyState !== 1 && socket.readyState != null)) {
      return;
    }
    socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  function open(nextToken: string) {
    if (closed || !nextToken) {
      return;
    }
    token = nextToken;
    const ws = new WebSocket(wsUrl(session.gatewayUrl, nextToken));
    socket = ws;
    ws.onmessage = (ev) => {
      let data: RealtimeEvent;
      try {
        data = JSON.parse(String(ev.data)) as RealtimeEvent;
      } catch {
        return;
      }
      if (data.type === "event") {
        onEvent(data);
      }
    };
    ws.onclose = () => {
      if (closed || typeof refresh !== "function") {
        return;
      }
      Promise.resolve(refresh({ gatewayUrl: session.gatewayUrl }))
        .then((data) => {
          const next = data?.access_token;
          if (closed || !next || next === token) {
            return;
          }
          deps.onSessionUpdate?.({ token: next, access_token: next, user: data.user });
          open(next);
        })
        .catch(() => {});
    };
  }
  open(token);
  const stop = (() => {
    closed = true;
    socket?.close();
  }) as StopHandle;
  stop.send = send;
  return stop;
}

export async function sendReply(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversation, content } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversation?.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        inbox_id: conversation?.inboxId,
        contact_id: conversation?.contactId,
        contact_inbox_id: conversation?.contactInboxId,
      }),
    },
  );
  if (!res.ok) {
    throw new Error("send failed");
  }
  return res.json();
}

export async function signIn({ gatewayUrl, email, password }: ClientReq, fetchImpl: FetchImpl = asFetch) {
  const base = gatewayUrl || "";
  const res = await fetchImpl(`${base}/auth/sign_in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error("unauthorized");
  }
  return res.json();
}

export async function signOut({ gatewayUrl }: ClientReq, fetchImpl: FetchImpl = asFetch) {
  const base = gatewayUrl || "";
  await fetchImpl(`${base}/auth/sign_out`, {
    method: "DELETE",
    credentials: "include",
  });
}

export async function listContacts(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/contacts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("list contacts failed");
  }
  return res.json();
}

export async function refreshSession({ gatewayUrl }: ClientReq, fetchImpl: FetchImpl = asFetch) {
  const base = gatewayUrl || "";
  try {
    const res = await fetchImpl(`${base}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
    });
    if (!res.ok) {
      return null;
    }
    return res.json();
  } catch {
    return null;
  }
}

export async function addInboxMember(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, inboxId, userId } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}/members/${userId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    throw new Error("add member failed");
  }
}

export async function listInboxMembers(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, inboxId } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}/members`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error("list members failed");
  }
  return res.json();
}

export async function assignConversation(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, assigneeId, expectedVersion } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/assignee`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assignee_id: assigneeId,
        expected_version: expectedVersion,
      }),
    },
  );
  if (!res.ok) {
    throw new Error("assign failed");
  }
  return res.json();
}

export async function removeConversationLabel(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, labelId } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels/${labelId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error("label remove failed");
  }
}

export async function listConversations(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("list conversations failed");
  }
  return res.json();
}

export async function listEgo(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, contactId } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/contacts/${contactId}/ego`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("ego failed");
  }
  return res.json();
}

export async function approveTool(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, executionId } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/tools/${executionId}/approve`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error("approve failed");
  }
  return res.json();
}

export async function listMessages(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error("list messages failed");
  }
  return res.json();
}

export async function resolveConversation(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, expectedVersion, newStatus } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/status`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        new_status: newStatus || "resolved",
        expected_version: expectedVersion,
      }),
    },
  );
  if (!res.ok) {
    throw new Error("resolve failed");
  }
  return res.json();
}

export async function addConversationLabel(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, name } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) {
    throw new Error("label failed");
  }
  return res.json();
}

export async function snoozeConversation(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, snoozedUntil, expectedVersion } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/snooze`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snoozed_until: snoozedUntil,
        expected_version: expectedVersion,
      }),
    },
  );
  if (!res.ok) {
    throw new Error("snooze failed");
  }
  return res.json();
}

export async function uploadAttachment(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversation, file } = req;
  const body = new FormData();
  body.append("file", file as Blob);
  body.append("inbox_id", conversation?.inboxId as string);
  body.append("contact_id", conversation?.contactId as string);
  body.append("contact_inbox_id", conversation?.contactInboxId as string);
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversation?.id}/attachments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    },
  );
  if (!res.ok) {
    throw new Error("attach failed");
  }
  return res.json();
}

export async function getInbox(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, inboxId } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("inbox get failed");
  }
  return res.json();
}

export async function rotateHmac(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, inboxId } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}/hmac/rotate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("hmac rotate failed");
  }
  return res.json();
}

export async function updateInbox(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, inboxId, greetingMessage, businessHoursEnabled, businessHours } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      greeting_message: greetingMessage || "",
      business_hours_enabled: !!businessHoursEnabled,
      business_hours: businessHours || {},
    }),
  });
  if (!res.ok) {
    throw new Error("inbox update failed");
  }
  return res.json();
}

export async function listAccountLabels(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/labels`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("label catalog failed");
  }
  return res.json();
}

export async function deleteAccountLabel(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, labelId } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/labels/${labelId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("label catalog delete failed");
  }
  return res.json();
}

export async function createAccountLabel(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, name } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error("label catalog create failed");
  }
  return res.json();
}

export async function listCanned(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/canned_responses`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("canned list failed");
  }
  return res.json();
}

export async function deleteCanned(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, canned_id } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/canned_responses/${canned_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("canned delete failed");
  }
  return res.json();
}

export async function createCanned(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, shortCode, content } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/canned_responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ short_code: shortCode, content }),
  });
  if (!res.ok) {
    throw new Error("canned create failed");
  }
  return res.json();
}

export async function listMacros(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/macros`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("macro list failed");
  }
  return res.json();
}

export async function createMacro(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, name, visibility, actions } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/macros`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, visibility, actions }),
  });
  if (!res.ok) {
    throw new Error("macro create failed");
  }
  return res.json();
}

export async function deleteMacro(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, macroId } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/macros/${macroId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("macro delete failed");
  }
  return res.json();
}

export async function executeMacro(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, macroId } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/macros/${macroId}/execute`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" },
  );
  if (!res.ok) {
    throw new Error("macro execute failed");
  }
  return res.json();
}

export async function getReport(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/reports`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("report failed");
  }
  return res.json();
}

export async function listWebhooks(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("webhook list failed");
  }
  return res.json();
}

export async function createWebhook(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, url, subscriptions } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, subscriptions }),
  });
  if (!res.ok) {
    throw new Error("webhook create failed");
  }
  return res.json();
}

export async function deleteWebhook(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, webhook_id } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/webhooks/${webhook_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("webhook delete failed");
  }
  return res.json();
}

export async function listArticles(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/articles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("article list failed");
  }
  return res.json();
}

export async function listMCP(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/mcp_servers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("mcp list failed");
  }
  return res.json();
}

export async function upsertMCP(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, name, url, auth_header, allowed_tools, high_risk_tools } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/mcp_servers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, url, auth_header, allowed_tools, high_risk_tools }),
  });
  if (!res.ok) {
    throw new Error("mcp create failed");
  }
  return res.json();
}

export async function rotateMCP(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, mcp_server_id, auth_header } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/mcp_servers/${mcp_server_id}/auth/rotate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ auth_header }),
  });
  if (!res.ok) {
    throw new Error("mcp rotate failed");
  }
  return res.json();
}

export async function deleteMCP(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, mcp_server_id } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/mcp_servers/${mcp_server_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("mcp delete failed");
  }
  return res.json();
}

export async function listSkills(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/agent_skills`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("skill list failed");
  }
  return res.json();
}

export async function upsertSkill(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, name, description, body } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/agent_skills`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description, body }),
  });
  if (!res.ok) {
    throw new Error("skill create failed");
  }
  return res.json();
}

export async function deleteSkill(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, skill_id } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/agent_skills/${skill_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("skill delete failed");
  }
  return res.json();
}

export async function deleteArticle(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, article_id } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/articles/${article_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("article delete failed");
  }
  return res.json();
}

export async function createArticle(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, title, slug, body, published } = req;
  const res = await fetchImpl(`${gatewayUrl}/api/v1/accounts/${accountId}/articles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, slug, body, published }),
  });
  if (!res.ok) {
    throw new Error("article create failed");
  }
  return res.json();
}

export async function sendNote(req: ClientReq, fetchImpl: FetchImpl = asFetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversationId, content } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/notes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) {
    throw new Error("note failed");
  }
  return res.json();
}

export const liveClient = {
  connect,
  sendReply,
  signIn,
  signOut,
  refresh: refreshSession,
  listContacts,
  addInboxMember,
  listInboxMembers,
  getInbox,
  rotateHmac,
  updateInbox,
  assignConversation,
  sendNote,
  snoozeConversation,
  addConversationLabel,
  removeConversationLabel,
  listAccountLabels,
  createAccountLabel,
  deleteAccountLabel,
  listCanned,
  createCanned,
  deleteCanned,
  listMacros,
  createMacro,
  deleteMacro,
  executeMacro,
  listConversations,
  listMessages,
  listEgo,
  approveTool,
  resolveConversation,
  uploadAttachment,
  getReport,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  listArticles,
  createArticle,
  deleteArticle,
  listMCP,
  upsertMCP,
  rotateMCP,
  deleteMCP,
  listSkills,
  upsertSkill,
  deleteSkill,
};

export type HelpdeskClient = typeof liveClient;
