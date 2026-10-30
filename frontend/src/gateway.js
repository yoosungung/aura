export function wsUrl(gatewayUrl, token) {
  const http = gatewayUrl || (typeof location === "undefined" ? "" : location.origin);
  return `${http.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

let refreshInFlight = null;

export async function requestWithAuth(req, url, init = {}, fetchImpl = fetch) {
  const headers = { ...(init.headers || {}) };
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
    refreshInFlight = Promise.resolve(refresh({ gatewayUrl: req.gatewayUrl })).finally(() => {
      refreshInFlight = null;
    });
  }
  const data = await refreshInFlight;
  const next = data?.access_token;
  if (!next) {
    return res;
  }
  onSessionUpdate?.({ token: next, access_token: next, user: data.user });
  return fetchImpl(url, { ...init, headers: { ...headers, Authorization: `Bearer ${next}` } });
}

function authed(req, fetchImpl) {
  return (url, init) => requestWithAuth(req, url, init || {}, fetchImpl);
}

let authHooks = {};

export function bindAuth(hooks) {
  authHooks = hooks || {};
}

export function connect(session, onEvent, deps = {}) {
  if (!session.token || typeof WebSocket === "undefined") {
    return () => {};
  }
  let closed = false;
  let socket;
  let token = session.token;
  const refresh = deps.refresh || session.refresh;
  function open(nextToken) {
    if (closed || !nextToken) {
      return;
    }
    token = nextToken;
    const ws = new WebSocket(wsUrl(session.gatewayUrl, nextToken));
    socket = ws;
    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
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
  return () => {
    closed = true;
    socket?.close();
  };
}

export async function sendReply(req, fetchImpl = fetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversation, content } = req;
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        inbox_id: conversation.inboxId,
        contact_id: conversation.contactId,
        contact_inbox_id: conversation.contactInboxId,
      }),
    },
  );
  if (!res.ok) {
    throw new Error("send failed");
  }
  return res.json();
}

export async function signIn({ gatewayUrl, email, password }, fetchImpl = fetch) {
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

export async function signOut({ gatewayUrl }, fetchImpl = fetch) {
  const base = gatewayUrl || "";
  await fetchImpl(`${base}/auth/sign_out`, {
    method: "DELETE",
    credentials: "include",
  });
}

export async function listContacts(req, fetchImpl = fetch) {
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

export async function refreshSession({ gatewayUrl }, fetchImpl = fetch) {
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

export async function addInboxMember(req, fetchImpl = fetch) {
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

export async function listInboxMembers(req, fetchImpl = fetch) {
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

export async function assignConversation(req, fetchImpl = fetch) {
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

export async function removeConversationLabel(req, fetchImpl = fetch) {
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

export async function listConversations(req, fetchImpl = fetch) {
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

export async function listMessages(req, fetchImpl = fetch) {
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

export async function resolveConversation(req, fetchImpl = fetch) {
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

export async function addConversationLabel(req, fetchImpl = fetch) {
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

export async function snoozeConversation(req, fetchImpl = fetch) {
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

export async function uploadAttachment(req, fetchImpl = fetch) {
  fetchImpl = authed(req, fetchImpl);
  const { gatewayUrl, accountId, token, conversation, file } = req;
  const body = new FormData();
  body.append("file", file);
  body.append("inbox_id", conversation.inboxId);
  body.append("contact_id", conversation.contactId);
  body.append("contact_inbox_id", conversation.contactInboxId);
  const res = await fetchImpl(
    `${gatewayUrl}/api/v1/accounts/${accountId}/conversations/${conversation.id}/attachments`,
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

export async function getInbox(req, fetchImpl = fetch) {
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

export async function rotateHmac(req, fetchImpl = fetch) {
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

export async function listAccountLabels(req, fetchImpl = fetch) {
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

export async function createAccountLabel(req, fetchImpl = fetch) {
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

export async function listCanned(req, fetchImpl = fetch) {
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

export async function createCanned(req, fetchImpl = fetch) {
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

export async function listMacros(req, fetchImpl = fetch) {
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

export async function createMacro(req, fetchImpl = fetch) {
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

export async function executeMacro(req, fetchImpl = fetch) {
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

export async function sendNote(req, fetchImpl = fetch) {
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
  assignConversation,
  sendNote,
  snoozeConversation,
  addConversationLabel,
  removeConversationLabel,
  listAccountLabels,
  createAccountLabel,
  listCanned,
  createCanned,
  listMacros,
  createMacro,
  executeMacro,
  listConversations,
  listMessages,
  resolveConversation,
  uploadAttachment,
};
