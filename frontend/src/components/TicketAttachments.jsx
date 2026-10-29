import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Label } from "./ui/label.jsx";

export function TicketAttachments({ session, conversation, client, onAttached }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    const picked = file || e.currentTarget.querySelector('input[type="file"]')?.files?.[0];
    if (!picked || !client.uploadAttachment) {
      return;
    }
    setError("");
    setPending(true);
    try {
      const data = await client.uploadAttachment({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversation,
        file: picked,
      });
      setFile(null);
      onAttached?.({ ...data, filename: picked.name });
      e.target.reset?.();
    } catch {
      setError("첨부를 올리지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="attach" aria-label="티켓 첨부">
      <Label>
        첨부 파일
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </Label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        첨부
      </Button>
    </form>
  );
}
