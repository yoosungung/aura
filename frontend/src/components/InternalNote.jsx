import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function InternalNote({ session, conversation, client, onNoted }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !client.sendNote) {
      return;
    }
    setError("");
    setPending(true);
    try {
      const data = await client.sendNote({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        content,
      });
      setDraft("");
      onNoted?.(data);
    } catch {
      setError("메모를 남기지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="note" aria-label="내부 메모">
      <Label>
        메모
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} required />
      </Label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        메모
      </Button>
    </form>
  );
}
