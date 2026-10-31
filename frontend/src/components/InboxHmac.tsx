import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";
import type { ClientReq, HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type InboxHmacProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

type InboxChoice = { id: string; name?: string };

export function InboxHmac({ session, client }: InboxHmacProps) {
  const [inboxId, setInboxId] = useState(session.inboxIds?.[0] || "");
  const [boxes, setBoxes] = useState<InboxChoice[]>([]);
  const [secret, setSecret] = useState("");
  const [greeting, setGreeting] = useState("");
  const [hoursOn, setHoursOn] = useState(false);
  const [hours, setHours] = useState("{}");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client.listInboxes) {
      return undefined;
    }
    let cancelled = false;
    client
      .listInboxes({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const next = (data?.inboxes || [])
          .filter((row: { id?: string }) => row.id)
          .map((row: { id: string; name?: string }) => ({ id: row.id, name: row.name }));
        setBoxes(next);
        setInboxId((cur) => cur || next[0]?.id || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  function applyInbox(data: any) {
    setSecret(data?.hmac_secret || "");
    setGreeting(data?.greeting_message || "");
    setHoursOn(!!data?.business_hours_enabled);
    const raw = data?.business_hours;
    setHours(typeof raw === "string" ? raw : JSON.stringify(raw || {}, null, 2));
    setRevealed(true);
  }

  async function load(fn?: (req: ClientReq) => Promise<any>) {
    if (!inboxId.trim() || !fn) {
      return;
    }
    setError("");
    setSaved(false);
    try {
      const data = await fn({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: inboxId.trim(),
      });
      applyInbox(data);
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

  async function onSave() {
    if (!inboxId.trim() || !client.updateInbox) {
      return;
    }
    setError("");
    setSaved(false);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = hours.trim() ? JSON.parse(hours) : {};
    } catch {
      setError("영업시간 JSON이 올바르지 않습니다");
      return;
    }
    try {
      const data = await client.updateInbox({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: inboxId.trim(),
        greetingMessage: greeting,
        businessHoursEnabled: hoursOn,
        businessHours: parsed,
      });
      applyInbox(data);
      setSaved(true);
    } catch {
      setError("인박스 설정을 저장하지 못했습니다");
    }
  }

  const inboxChoices =
    boxes.length > 0 ? boxes : (session.inboxIds || []).map((id) => ({ id, name: id }));

  return (
    <section className="hmac" aria-label="HMAC 시크릿">
      <h2>HMAC 시크릿</h2>
      {inboxChoices.length ? (
        <Label>
          인박스
          <select aria-label="인박스" value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
            {inboxChoices.map((box) => (
              <option key={box.id} value={box.id}>
                {box.name || box.id}
              </option>
            ))}
          </select>
        </Label>
      ) : null}
      <Label className={inboxChoices.length ? "field-fallback" : undefined}>
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
      <Label>
        부재중 인사
        <Textarea aria-label="부재중 인사" value={greeting} onChange={(e) => setGreeting(e.target.value)} />
      </Label>
      <Label>
        <Input
          type="checkbox"
          checked={hoursOn}
          onChange={(e) => setHoursOn(e.target.checked)}
          aria-label="영업시간 사용"
        />
        영업시간 사용
      </Label>
      <Label>
        영업시간
        <Textarea aria-label="영업시간" value={hours} onChange={(e) => setHours(e.target.value)} />
      </Label>
      <Button type="button" onClick={onSave}>
        저장
      </Button>
      {copied ? <p>복사됨</p> : null}
      {saved ? <p>저장됨</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
