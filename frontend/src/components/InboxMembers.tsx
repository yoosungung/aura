import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type InboxMember = {
  user_id: string;
  name?: string;
  email?: string;
};

type InboxMembersProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

export function InboxMembers({ session, client }: InboxMembersProps) {
  const [inboxId, setInboxId] = useState(session.inboxIds?.[0] || "");
  const [userId, setUserId] = useState("");
  const [members, setMembers] = useState<InboxMember[]>([]);
  const [directory, setDirectory] = useState<InboxMember[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const listInboxMembers = client.listInboxMembers;
    if (!listInboxMembers) {
      return undefined;
    }
    const ids = [...new Set([...(session.inboxIds || []), inboxId].filter(Boolean))];
    if (ids.length === 0) {
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      ids.map((id) =>
        listInboxMembers({
            gatewayUrl: session.gatewayUrl,
            accountId: session.accountId,
            token: session.token,
            inboxId: id,
          })
          .then((data) => ({ id, members: (data?.members || []) as InboxMember[] }))
          .catch(() => ({ id, members: [] as InboxMember[] })),
      ),
    ).then((rows) => {
      if (cancelled) {
        return;
      }
      setMembers(rows.find((row) => row.id === inboxId)?.members || []);
      const seen = new Set<string>();
      const next: InboxMember[] = [];
      for (const row of rows) {
        for (const m of row.members) {
          if (m.user_id && !seen.has(m.user_id)) {
            seen.add(m.user_id);
            next.push(m);
          }
        }
      }
      setDirectory(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client, inboxId, session]);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!inboxId.trim() || !userId.trim() || !client.addInboxMember) {
      return;
    }
    try {
      await client.addInboxMember({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: inboxId.trim(),
        userId: userId.trim(),
      });
      setUserId("");
      if (client.listInboxMembers) {
        const data = await client.listInboxMembers({
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          inboxId: inboxId.trim(),
        });
        setMembers(data?.members || []);
      }
    } catch {
      setError("추가하지 못했습니다");
    }
  }

  async function onRemove(member: InboxMember) {
    if (!inboxId.trim() || !member?.user_id || !client.removeInboxMember) {
      return;
    }
    setError("");
    try {
      await client.removeInboxMember({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: inboxId.trim(),
        userId: member.user_id,
      });
      setMembers((prev) => prev.filter((m) => m.user_id !== member.user_id));
    } catch {
      setError("삭제하지 못했습니다");
    }
  }

  const taken = new Set(members.map((m) => m.user_id));
  const agentChoices = directory.filter((m) => !taken.has(m.user_id));

  return (
    <section className="members" aria-label="인박스 멤버">
      <h2>인박스 멤버</h2>
      <form onSubmit={onAdd} className="flex flex-col gap-2">
        {session.inboxIds?.length ? (
          <Label>
            인박스
            <select aria-label="인박스" value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
              {session.inboxIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Label>
        ) : null}
        <Label className={session.inboxIds?.length ? "field-fallback" : undefined}>
          인박스 ID
          <Input value={inboxId} onChange={(e) => setInboxId(e.target.value)} required />
        </Label>
        {agentChoices.length > 0 ? (
          <Label>
            상담원
            <select aria-label="상담원" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">선택</option>
              {agentChoices.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name || m.email || m.user_id}
                </option>
              ))}
            </select>
          </Label>
        ) : null}
        <Label className={agentChoices.length > 0 ? "field-fallback" : undefined}>
          상담원 ID
          <Input value={userId} onChange={(e) => setUserId(e.target.value)} required />
        </Label>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit">추가</Button>
      </form>
      {members.length > 0 ? (
        <ul className="settings-list">
          {members.map((m) => (
            <li key={m.user_id}>
              <span className="settings-item-main">{m.email || m.user_id}</span>
              {client.removeInboxMember ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(m)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
