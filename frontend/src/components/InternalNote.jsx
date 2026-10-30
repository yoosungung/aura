import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";

export function InternalNote({ onSend }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e) {
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
      <Label>
        메모
        <Textarea
          aria-label="메모"
          placeholder="내부 메모 (고객에게 보이지 않음)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          required
        />
      </Label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" variant="warning">
        메모
      </Button>
    </form>
  );
}
