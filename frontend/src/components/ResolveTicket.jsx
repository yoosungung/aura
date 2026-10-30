import { useState } from "react";
import { Button } from "./ui/button.jsx";

export function ResolveTicket({ session, conversation, client, onResolved }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function onStatus(newStatus) {
    if (!client.resolveConversation) {
      return;
    }
    setError("");
    setBusy(newStatus);
    try {
      const data = await client.resolveConversation({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        expectedVersion: conversation.version || 1,
        newStatus,
      });
      onResolved?.({ conversationId: conversation.id, status: data.status, version: data.version });
    } catch {
      setError(newStatus === "pending" ? "대기로 바꾸지 못했습니다" : "해결하지 못했습니다");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="resolve flex items-center gap-2 p-3" aria-label="티켓 해결">
      {error ? <p role="alert">{error}</p> : null}
      {conversation.status !== "pending" ? (
        <Button type="button" variant="outline" onClick={() => onStatus("pending")} disabled={!!busy}>
          대기
        </Button>
      ) : null}
      <Button type="button" onClick={() => onStatus("resolved")} disabled={!!busy}>
        해결
      </Button>
    </div>
  );
}
