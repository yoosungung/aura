import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function SnoozeTicket({ session, conversation, client, onSnoozed }) {
  const [until, setUntil] = useState(conversation.snoozedUntil || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    const value = until.trim();
    if (!value || !client.snoozeConversation) {
      return;
    }
    setPending(true);
    try {
      const data = await client.snoozeConversation({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        snoozedUntil: value,
        expectedVersion: conversation.version || 1,
      });
      onSnoozed?.({
        conversationId: conversation.id,
        status: data.status,
        version: data.version,
        snoozedUntil: data.snoozed_until,
      });
    } catch {
      setError("스누즈하지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  function presetHours(hours) {
    setUntil(new Date(Date.now() + hours * 3600_000).toISOString());
  }

  return (
    <form onSubmit={onSubmit} className="snooze" aria-label="티켓 스누즈">
      <Button type="button" variant="outline" size="sm" onClick={() => presetHours(1)}>
        1시간 뒤
      </Button>
      <Label>
        스누즈 시각
        <Input value={until} onChange={(e) => setUntil(e.target.value)} required />
      </Label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" size="sm" disabled={pending}>
        스누즈
      </Button>
    </form>
  );
}
