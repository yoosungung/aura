import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function InboxMembers({ session, client }) {
  const [inboxId, setInboxId] = useState(session.inboxIds?.[0] || "");
  const [userId, setUserId] = useState("");
  const [members, setMembers] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
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
      .catch(() => {
        if (!cancelled) {
          setError("멤버를 불러오지 못했습니다");
        }
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

  return (
    <section className="members" aria-label="인박스 멤버">
      <h2>인박스 멤버</h2>
      <form onSubmit={onAdd} className="flex flex-col gap-2">
        <Label>
          인박스 ID
          <Input value={inboxId} onChange={(e) => setInboxId(e.target.value)} required />
        </Label>
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
