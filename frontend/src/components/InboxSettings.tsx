import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";
import { serializeBusinessHours } from "../hours.js";
import { channelLabel } from "../store.js";
import { emptyInboxOps, InboxHmac, type InboxOps } from "./InboxHmac.jsx";

type InboxRow = {
  id?: string;
  name?: string;
  channel_type?: string;
  email_address?: string;
  kakao_sender_key?: string;
};

type InboxSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
  onSession?: (next: unknown) => void;
};

export function InboxSettings({ session, client, onSession }: InboxSettingsProps) {
  const [boxes, setBoxes] = useState<InboxRow[]>([]);
  const [channels, setChannels] = useState<string[]>(["web", "email", "kakao"]);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("web");
  const [email, setEmail] = useState("");
  const [kakao, setKakao] = useState("");
  const [editingId, setEditingId] = useState("");
  const [ops, setOps] = useState<InboxOps>(emptyInboxOps);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const req = {
      gatewayUrl: session.gatewayUrl,
      accountId: session.accountId,
      token: session.token,
    };
    (client.listChannels ? client.listChannels(req) : Promise.resolve({ channel_types: ["web", "email", "kakao"] }))
      .then((data) => {
        if (!cancelled && data?.channel_types?.length) {
          setChannels(data.channel_types);
        }
      })
      .catch(() => {});
    (client.listInboxes ? client.listInboxes(req) : Promise.resolve({ inboxes: [] }))
      .then((data) => {
        if (!cancelled) {
          setBoxes(data?.inboxes || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  function resetForm() {
    setEditingId("");
    setName("");
    setChannel(channels[0] || "web");
    setEmail("");
    setKakao("");
    setOps(emptyInboxOps());
    setError("");
  }

  function selectBox(box: InboxRow) {
    setEditingId(box.id || "");
    setName(box.name || "");
    setChannel(box.channel_type || "web");
    setEmail(box.email_address || "");
    setKakao(box.kakao_sender_key || "");
    setOps(emptyInboxOps());
  }

  async function refreshSession() {
    if (!client.refresh || !onSession) {
      return;
    }
    const next = await client.refresh({ gatewayUrl: session.gatewayUrl });
    if (next) {
      onSession(next);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }
    setError("");
    const payload = {
      gatewayUrl: session.gatewayUrl,
      accountId: session.accountId,
      token: session.token,
      name: name.trim(),
      channelType: channel,
      emailAddress: channel === "email" ? email.trim() : "",
      kakaoSenderKey: channel === "kakao" ? kakao.trim() : "",
      ...(editingId && channel === "web"
        ? {
            greetingMessage: ops.greeting,
            businessHoursEnabled: ops.hoursOn,
            businessHours: serializeBusinessHours(ops.hours),
          }
        : {}),
    };
    try {
      if (editingId && client.updateInbox) {
        const updated = await client.updateInbox({ ...payload, inboxId: editingId });
        setBoxes((prev) => prev.map((row) => (row.id === editingId ? { ...row, ...updated } : row)));
        resetForm();
        return;
      }
      if (!client.createInbox) {
        return;
      }
      const created = await client.createInbox(payload);
      setBoxes((prev) => [...prev, created]);
      setName("");
      setChannel(channels[0] || "web");
      setEmail("");
      setKakao("");
      await refreshSession();
    } catch {
      setError(editingId ? "인박스를 수정하지 못했습니다" : "인박스를 만들지 못했습니다");
    }
  }

  async function onDelete(box: InboxRow) {
    if (!client.deleteInbox || !box?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteInbox({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        inboxId: box.id,
      });
      setBoxes((prev) => prev.filter((row) => row.id !== box.id));
      if (editingId === box.id) {
        resetForm();
      }
      await refreshSession();
    } catch {
      setError("인박스를 삭제하지 못했습니다");
    }
  }

  return (
    <section className="settings-resource" aria-label="인박스">
      <h2>인박스</h2>
      <ul className="settings-list">
        {boxes.map((box) => (
          <li key={box.id || box.name}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="settings-item-main justify-start"
              aria-current={box.id && box.id === editingId ? "true" : undefined}
              onClick={() => selectBox(box)}
            >
              {box.name} · {channelLabel(box.channel_type)}
            </Button>
            {client.updateInbox && box.id ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => selectBox(box)}>
                수정
              </Button>
            ) : null}
            {client.deleteInbox && box.id ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onDelete(box)}>
                삭제
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <form onSubmit={onSave} className="flex flex-col gap-2">
        <Label>
          이름
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Label>
        <Label>
          채널
          <select aria-label="채널" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((t) => (
              <option key={t} value={t}>
                {channelLabel(t) || t}
              </option>
            ))}
          </select>
        </Label>
        {channel === "email" ? (
          <Label>
            이메일
            <Input value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Label>
        ) : null}
        {channel === "kakao" ? (
          <Label>
            카카오 발신 키
            <Input value={kakao} onChange={(e) => setKakao(e.target.value)} required />
          </Label>
        ) : null}
        {editingId && channel === "web" ? (
          <InboxHmac
            session={session}
            client={client}
            inboxId={editingId}
            ops={ops}
            onOps={setOps}
          />
        ) : null}
        <div className="settings-form-actions">
          {editingId ? (
            <Button type="button" size="sm" variant="secondary" onClick={resetForm}>
              취소
            </Button>
          ) : null}
          <Button type="submit" size="sm">
            {editingId ? "인박스 저장" : "인박스 추가"}
          </Button>
        </div>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
