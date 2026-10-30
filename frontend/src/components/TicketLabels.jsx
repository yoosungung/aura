import { useEffect, useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function TicketLabels({ session, conversation, client, onLabeled, onUnlabeled }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const labels = conversation.labels || [];

  useEffect(() => {
    if (!client.listAccountLabels) {
      return undefined;
    }
    let cancelled = false;
    client
      .listAccountLabels({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setCatalog(data?.labels || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  async function attachName(value) {
    const next = value.trim();
    if (!next || !client.addConversationLabel) {
      return;
    }
    setError("");
    setPending(true);
    try {
      const data = await client.addConversationLabel({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        name: next,
      });
      setName("");
      onLabeled?.({ conversationId: conversation.id, label: data });
    } catch {
      setError("라벨을 붙이지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    await attachName(name);
  }

  const taken = new Set(labels.map((l) => l.name));
  const unused = catalog.filter((l) => l.name && !taken.has(l.name));

  return (
    <section className="labels" aria-label="티켓 라벨">
      {labels.length > 0 ? (
        <ul>
          {labels.map((l) => (
            <li key={l.id || l.name} className="flex items-center gap-2">
              <Badge variant="secondary">{l.name}</Badge>
              {l.id && client.removeConversationLabel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await client.removeConversationLabel({
                        gatewayUrl: session.gatewayUrl,
                        accountId: session.accountId,
                        token: session.token,
                        conversationId: conversation.id,
                        labelId: l.id,
                      });
                      onUnlabeled?.({ conversationId: conversation.id, labelId: l.id });
                    } catch {
                      setError("라벨을 제거하지 못했습니다");
                    }
                  }}
                >
                  제거
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {unused.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {unused.map((l) => (
            <Button
              key={l.id || l.name}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => attachName(l.name)}
            >
              {l.name}
            </Button>
          ))}
        </div>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <Label>
          라벨 이름
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            list="account-labels"
            required
          />
        </Label>
        <datalist id="account-labels">
          {catalog.map((l) => (
            <option key={l.id || l.name} value={l.name} />
          ))}
        </datalist>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          부착
        </Button>
      </form>
    </section>
  );
}
