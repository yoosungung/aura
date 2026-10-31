import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Conversation, Session } from "../store.js";

type InboxMember = {
  user_id: string;
  name?: string;
  email?: string;
};

type AssignTicketProps = {
  session: Session;
  conversation: Conversation;
  client: Partial<HelpdeskClient>;
  onAssigned?: (next: { conversationId: string; assigneeId?: string; status?: string; version?: number }) => void;
};

export function AssignTicket({ session, conversation, client, onAssigned }: AssignTicketProps) {
  const [assigneeId, setAssigneeId] = useState(conversation.assigneeId || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [members, setMembers] = useState<InboxMember[]>([]);

  useEffect(() => {
    const inboxId = conversation.inboxId || session.inboxIds?.[0];
    if (!inboxId || !client.listInboxMembers) {
      return undefined;
    }
    let cancelled = false;
    client
      .listInboxMembers({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId,
      })
      .then((data) => {
        if (!cancelled) {
          setMembers(data?.members || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, conversation.inboxId, session]);

  async function assignTo(id: string) {
    setError("");
    if (!id || !client.assignConversation) {
      return;
    }
    setPending(true);
    try {
      const data = await client.assignConversation({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        assigneeId: id,
        expectedVersion: conversation.version || 1,
      });
      onAssigned?.({
        conversationId: conversation.id,
        assigneeId: data.assignee_id,
        status: data.status,
        version: data.version,
      });
    } catch {
      setError("배정하지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await assignTo(assigneeId.trim());
  }

  return (
    <form onSubmit={onSubmit} className="assign" aria-label="티켓 배정">
      {members.length > 0 ? (
        <Label>
          담당자
          <select
            aria-label="담당자"
            value={assigneeId}
            onChange={(e) => {
              const id = e.target.value;
              setAssigneeId(id);
              if (id) {
                assignTo(id);
              }
            }}
          >
            <option value="">선택</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.name || m.email || m.user_id}
              </option>
            ))}
          </select>
        </Label>
      ) : null}
      <Label className={members.length > 0 ? "field-fallback" : undefined}>
        담당자 ID
        <Input
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          list="inbox-members"
          required
        />
      </Label>
      <datalist id="inbox-members">
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {m.email || m.user_id}
          </option>
        ))}
      </datalist>
      {error ? <p role="alert">{error}</p> : null}
      {session.userId ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setAssigneeId(session.userId || "");
            assignTo(session.userId || "");
          }}
        >
          나에게 배정
        </Button>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        배정
      </Button>
    </form>
  );
}
