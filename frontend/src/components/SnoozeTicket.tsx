import { useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Conversation, Session } from "../store.js";

type SnoozeTicketProps = {
  session: Session;
  conversation: Conversation;
  client: Partial<HelpdeskClient>;
  onSnoozed?: (next: {
    conversationId: string;
    status?: string;
    version?: number;
    snoozedUntil?: string;
  }) => void;
};

export function SnoozeTicket({ session, conversation, client, onSnoozed }: SnoozeTicketProps) {
  const [until, setUntil] = useState(conversation.snoozedUntil || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function snoozeTo(localValue?: string) {
    setError("");
    const value = toRFC3339((localValue ?? until).trim());
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await snoozeTo(until);
  }

  function applyPreset(localValue: string) {
    setUntil(localValue);
    snoozeTo(localValue);
  }

  function presetHours(hours: number) {
    applyPreset(toLocalInput(new Date(Date.now() + hours * 3600_000)));
  }

  function presetTodaySix() {
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= Date.now()) {
      d.setDate(d.getDate() + 1);
    }
    applyPreset(toLocalInput(d));
  }

  function presetTomorrowNine() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    applyPreset(toLocalInput(d));
  }

  function presetNextMonday() {
    const d = new Date();
    const add = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + add);
    d.setHours(9, 0, 0, 0);
    applyPreset(toLocalInput(d));
  }

  return (
    <form onSubmit={onSubmit} className="snooze" aria-label="티켓 스누즈">
      <Button type="button" variant="outline" size="sm" onClick={() => presetHours(1)}>
        1시간 뒤
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={presetTodaySix}>
        오늘 오후 6시
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={presetTomorrowNine}>
        내일 09:00
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={presetNextMonday}>
        다음 주 월요일
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

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toRFC3339(value: string) {
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
