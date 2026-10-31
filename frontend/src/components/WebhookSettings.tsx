import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type Webhook = { id?: string; url?: string };

type WebhookSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

export function WebhookSettings({ session, client }: WebhookSettingsProps) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [editingId, setEditingId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client.listWebhooks) {
      return undefined;
    }
    let cancelled = false;
    client
      .listWebhooks({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setHooks(data?.webhooks || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  function resetForm() {
    setEditingId("");
    setUrl("");
    setError("");
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) {
      return;
    }
    setError("");
    try {
      if (editingId && client.updateWebhook) {
        const updated = await client.updateWebhook({
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          webhook_id: editingId,
          url: url.trim(),
          subscriptions: ["message_created"],
        });
        setHooks((prev) => prev.map((h) => (h.id === editingId ? { ...h, ...updated } : h)));
        resetForm();
        return;
      }
      if (!client.createWebhook) {
        return;
      }
      const created = await client.createWebhook({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        url: url.trim(),
        subscriptions: ["message_created"],
      });
      setHooks((prev) => [...prev, created]);
      setUrl("");
    } catch {
      setError(editingId ? "웹훅을 수정하지 못했습니다" : "웹훅을 만들지 못했습니다");
    }
  }

  async function onDelete(hook: Webhook) {
    if (!client.deleteWebhook || !hook?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteWebhook({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        webhook_id: hook.id,
      });
      setHooks((prev) => prev.filter((h) => h.id !== hook.id));
      if (editingId === hook.id) {
        resetForm();
      }
    } catch {
      setError("웹훅을 삭제하지 못했습니다");
    }
  }

  return (
    <section className="settings-resource" aria-label="웹훅">
      <h2>아웃바운드 웹훅</h2>
      <ul className="settings-list">
        {hooks.map((h) => (
          <li key={h.id || h.url}>
            <span className="settings-item-main">{h.url}</span>
            {client.updateWebhook && h.id ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingId(h.id || "");
                  setUrl(h.url || "");
                }}
              >
                수정
              </Button>
            ) : null}
            {client.deleteWebhook && h.id ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onDelete(h)}>
                삭제
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <form onSubmit={onSave} className="flex flex-col gap-2">
        <Label>
          웹훅 URL
          <Input value={url} onChange={(e) => setUrl(e.target.value)} required />
        </Label>
        <div className="settings-form-actions">
          {editingId ? (
            <Button type="button" size="sm" variant="secondary" onClick={resetForm}>
              취소
            </Button>
          ) : null}
          <Button type="submit" size="sm">
            {editingId ? "웹훅 저장" : "웹훅 추가"}
          </Button>
        </div>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
