export function wsUrl(gatewayUrl, token) {
  const http = gatewayUrl || (typeof location === "undefined" ? "" : location.origin);
  return `${http.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

export function connect(session, onEvent) {
  if (!session.token || typeof WebSocket === "undefined") {
    return () => {};
  }
  const ws = new WebSocket(wsUrl(session.gatewayUrl, session.token));
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
  return () => ws.close();
}

export async function sendReply(req, fetchImpl = fetch) {
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

export async function addConversationLabel(req, fetchImpl = fetch) {
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

export async function sendNote(req, fetchImpl = fetch) {
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
  refresh: refreshSession,
  addInboxMember,
  listInboxMembers,
  assignConversation,
  sendNote,
  snoozeConversation,
  addConversationLabel,
};
