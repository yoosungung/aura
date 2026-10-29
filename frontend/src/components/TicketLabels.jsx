import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";

export function TicketLabels({ session, conversation, client, onLabeled }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const labels = conversation.labels || [];

  async function onSubmit(e) {
    e.preventDefault();
    const value = name.trim();
    if (!value || !client.addConversationLabel) {
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
        name: value,
      });
      setName("");
      onLabeled?.({ conversationId: conversation.id, label: data });
    } catch {
      setError("라벨을 붙이지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="labels" aria-label="티켓 라벨">
      {labels.length > 0 ? (
        <ul>
          {labels.map((l) => (
            <li key={l.id || l.name}>{l.name}</li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          라벨 이름
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          부착
        </Button>
      </form>
    </section>
  );
}
