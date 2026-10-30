import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function InboxHmac({ session, client }) {
  const [inboxId, setInboxId] = useState(session.inboxIds?.[0] || "");
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function load(fn) {
    if (!inboxId.trim() || !fn) {
      return;
    }
    setError("");
    try {
      const data = await fn({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: inboxId.trim(),
      });
      setSecret(data?.hmac_secret || "");
      setRevealed(true);
    } catch {
      setError("시크릿을 불러오지 못했습니다");
    }
  }

  async function onCopy() {
    if (!secret) {
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("복사하지 못했습니다");
    }
  }

  return (
    <section className="hmac" aria-label="HMAC 시크릿">
      <h2>HMAC 시크릿</h2>
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
      {revealed && secret ? <p>{secret}</p> : <p>••••••••</p>}
      <div className="flex gap-2">
        <Button type="button" onClick={() => load(client.getInbox)}>
          보기
        </Button>
        <Button type="button" variant="secondary" onClick={onCopy} disabled={!secret}>
          복사
        </Button>
        <Button type="button" variant="secondary" onClick={() => load(client.rotateHmac)}>
          재발급
        </Button>
      </div>
      {copied ? <p>복사됨</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
