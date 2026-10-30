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
    const value = toRFC3339(until.trim());
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
    setUntil(toLocalInput(new Date(Date.now() + hours * 3600_000)));
  }

  function presetTomorrowNine() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setUntil(toLocalInput(d));
  }

  return (
    <form onSubmit={onSubmit} className="snooze" aria-label="티켓 스누즈">
      <Button type="button" variant="outline" size="sm" onClick={() => presetHours(1)}>
        1시간 뒤
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={presetTomorrowNine}>
        내일 09:00
      </Button>
      <Label>
        스누즈 시각
        <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} required />
      </Label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" size="sm" disabled={pending}>
        스누즈
      </Button>
    </form>
  );
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toRFC3339(value) {
  if (!value) {
    return "";
  }
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return d.toISOString();
}
