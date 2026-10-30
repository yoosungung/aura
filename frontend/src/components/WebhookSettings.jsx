import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function WebhookSettings({ session, client }) {
  const [hooks, setHooks] = useState([]);
  const [url, setUrl] = useState("");
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

  async function onCreate(e) {
    e.preventDefault();
    if (!client.createWebhook || !url.trim()) {
      return;
    }
    setError("");
    try {
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
      setError("웹훅을 만들지 못했습니다");
    }
  }

  return (
    <section className="catalog" aria-label="웹훅">
      <h2>아웃바운드 웹훅</h2>
      <ul>
        {hooks.map((h) => (
          <li key={h.id || h.url}>{h.url}</li>
        ))}
      </ul>
      <form onSubmit={onCreate} className="flex flex-col gap-2">
        <Label>
          웹훅 URL
          <Input value={url} onChange={(e) => setUrl(e.target.value)} required />
        </Label>
        <Button type="submit">웹훅 추가</Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
