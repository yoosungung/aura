import { useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Textarea } from "./ui/textarea.jsx";

type InternalNoteProps = {
  onSend?: (content: string) => Promise<unknown> | unknown;
};

export function InternalNote({ onSend }: InternalNoteProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !onSend) {
      return;
    }
    setError("");
    setDraft("");
    try {
      await onSend(content);
    } catch {
      setError("메모를 남기지 못했습니다");
    }
  }

  return (
    <form onSubmit={onSubmit} className="note" aria-label="내부 메모">
      <Textarea
        aria-label="메모"
        placeholder="내부 메모 (고객에게 보이지 않음)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        required
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" variant="warning">
        메모
      </Button>
    </form>
  );
}
