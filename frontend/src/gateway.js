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

export const liveClient = { connect, sendReply };
