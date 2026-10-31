import { useEffect, useRef, useState } from "react";
import { defaultHours, HOUR_DAYS, parseBusinessHours, type HoursForm } from "../hours.js";
import type { ClientReq, HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";

export type InboxOps = {
  greeting: string;
  hoursOn: boolean;
  hours: HoursForm;
};

type InboxHmacProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
  inboxId: string;
  ops: InboxOps;
  onOps: (next: InboxOps) => void;
};

export const emptyInboxOps = (): InboxOps => ({
  greeting: "",
  hoursOn: false,
  hours: defaultHours(),
});

export function InboxHmac({ session, client, inboxId, ops, onOps }: InboxHmacProps) {
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const onOpsRef = useRef(onOps);
  const dirtyRef = useRef(false);
  onOpsRef.current = onOps;

  function applySecret(data: { hmac_secret?: string }, revealSecret: boolean) {
    setSecret(data?.hmac_secret || "");
    if (revealSecret) {
      setRevealed(true);
    }
  }

  function applyOps(data: {
    greeting_message?: string;
    business_hours_enabled?: boolean;
    business_hours?: unknown;
  }) {
    if (dirtyRef.current) {
      return;
    }
    onOpsRef.current({
      greeting: data?.greeting_message || "",
      hoursOn: !!data?.business_hours_enabled,
      hours: parseBusinessHours(data?.business_hours),
    });
  }

  function setOps(next: InboxOps) {
    dirtyRef.current = true;
    onOps(next);
  }

  useEffect(() => {
    dirtyRef.current = false;
    setSecret("");
    setRevealed(false);
    setCopied(false);
    setError("");
    if (!inboxId.trim() || !client.getInbox) {
      return undefined;
    }
    let cancelled = false;
    client
      .getInbox({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: inboxId.trim(),
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        applySecret(data, false);
        applyOps(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, inboxId, session]);

  async function load(fn?: (req: ClientReq) => Promise<any>, revealSecret = true) {
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
      applySecret(data, revealSecret);
      applyOps(data);
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

  function patchDay(key: string, patch: Partial<HoursForm["week"][keyof HoursForm["week"]]>) {
    setOps({
      ...ops,
      hours: {
        ...ops.hours,
        week: {
          ...ops.hours.week,
          [key]: { ...ops.hours.week[key as keyof HoursForm["week"]], ...patch },
        },
      },
    });
  }

  return (
    <section className="hmac flex flex-col" aria-label="HMAC 시크릿">
      <Label>
        HMAC 시크릿
        <div className="flex items-center gap-2">
          <Input
            readOnly
            aria-label="HMAC 시크릿"
            value={revealed && secret ? secret : "••••••••"}
          />
          <Button type="button" size="sm" onClick={() => load(client.getInbox)}>
            보기
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onCopy} disabled={!secret}>
            복사
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => load(client.rotateHmac)}>
            재발급
          </Button>
        </div>
      </Label>
      {copied ? <p>복사됨</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <Label className="mt-4">
        부재중 인사
        <Textarea
          aria-label="부재중 인사"
          value={ops.greeting}
          onChange={(e) => setOps({ ...ops, greeting: e.target.value })}
        />
      </Label>
      <Label className="mt-4 flex-row items-center gap-2">
        <input
          type="checkbox"
          className="size-4 shrink-0"
          checked={ops.hoursOn}
          onChange={(e) => setOps({ ...ops, hoursOn: e.target.checked })}
        />
        영업시간 사용
      </Label>
      {ops.hoursOn
        ? HOUR_DAYS.map((day) => {
            const row = ops.hours.week[day.key];
            return (
              <div key={day.key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 shrink-0"
                  checked={row.open}
                  aria-label={`${day.label} 영업`}
                  onChange={(e) => patchDay(day.key, { open: e.target.checked })}
                />
                <span className="w-4 text-sm">{day.label}</span>
                <Input
                  type="time"
                  className="h-8 w-40"
                  aria-label={`${day.label} 시작`}
                  value={row.start}
                  disabled={!row.open}
                  onChange={(e) => patchDay(day.key, { start: e.target.value })}
                />
                <Input
                  type="time"
                  className="h-8 w-40"
                  aria-label={`${day.label} 종료`}
                  value={row.end}
                  disabled={!row.open}
                  onChange={(e) => patchDay(day.key, { end: e.target.value })}
                />
              </div>
            );
          })
        : null}
    </section>
  );
}
