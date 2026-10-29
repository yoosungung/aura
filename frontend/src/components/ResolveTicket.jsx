import { useState } from "react";
import { Button } from "./ui/button.jsx";

export function ResolveTicket({ session, conversation, client, onResolved }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onResolve() {
    if (!client.resolveConversation) {
      return;
    }
    setError("");
    setPending(true);
    try {
      const data = await client.resolveConversation({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        expectedVersion: conversation.version || 1,
      });
      onResolved?.({ conversationId: conversation.id, status: data.status, version: data.version });
    } catch {
      setError("해결하지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="resolve flex items-center gap-2 p-3" aria-label="티켓 해결">
      {error ? <p role="alert">{error}</p> : null}
      <Button type="button" onClick={onResolve} disabled={pending}>
        해결
      </Button>
    </div>
  );
}
