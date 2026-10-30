import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function InboxMembers({ session, client }) {
  const [inboxId, setInboxId] = useState(session.inboxIds?.[0] || "");
  const [userId, setUserId] = useState("");
  const [members, setMembers] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client.listInboxMembers) {
      return undefined;
    }
    const ids = [...new Set([...(session.inboxIds || []), inboxId].filter(Boolean))];
    if (ids.length === 0) {
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      ids.map((id) =>
        client
          .listInboxMembers({
            gatewayUrl: session.gatewayUrl,
            accountId: session.accountId,
            token: session.token,
            inboxId: id,
          })
          .then((data) => ({ id, members: data?.members || [] }))
          .catch(() => ({ id, members: [] })),
      ),
    ).then((rows) => {
      if (cancelled) {
        return;
      }
      setMembers(rows.find((row) => row.id === inboxId)?.members || []);
      const seen = new Set();
      const next = [];
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

  async function onAdd(e) {
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
        <Label>
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
        <Label>
          상담원 ID
          <Input value={userId} onChange={(e) => setUserId(e.target.value)} required />
        </Label>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit">추가</Button>
      </form>
      {members.length > 0 ? (
        <ul>
          {members.map((m) => (
            <li key={m.user_id}>{m.email || m.user_id}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
