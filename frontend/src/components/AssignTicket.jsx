import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function AssignTicket({ session, conversation, client, onAssigned }) {
  const [assigneeId, setAssigneeId] = useState(conversation.assigneeId || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [members, setMembers] = useState([]);

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

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    const id = assigneeId.trim();
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

  return (
    <form onSubmit={onSubmit} className="assign" aria-label="티켓 배정">
      <Label>
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
          onClick={() => setAssigneeId(session.userId)}
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
