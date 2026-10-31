import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Conversation, Session } from "../store.js";

type TicketAttachmentsProps = {
  session: Session;
  conversation: Conversation;
  client: Partial<HelpdeskClient>;
  onAttached?: (data: any) => void;
};

export function TicketAttachments({ session, conversation, client, onAttached }: TicketAttachmentsProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function uploadPicked(picked: File | null, form?: HTMLFormElement | null) {
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
      form?.reset?.();
    } catch {
      setError("첨부를 올리지 못했습니다");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    const dock = document.querySelector(".composer-dock");
    if (!dock) {
      return undefined;
    }
    function pickedFile(bag: DataTransfer | null | undefined) {
      return bag?.files?.[0] || null;
    }
    function onDragOver(e: Event) {
      e.preventDefault();
    }
    function onDrop(e: Event) {
      e.preventDefault();
      uploadPicked(pickedFile((e as DragEvent).dataTransfer));
    }
    function onPaste(e: Event) {
      const picked = pickedFile((e as ClipboardEvent).clipboardData);
      if (!picked) {
        return;
      }
      e.preventDefault();
      uploadPicked(picked);
    }
    dock.addEventListener("dragover", onDragOver);
    dock.addEventListener("drop", onDrop);
    dock.addEventListener("paste", onPaste);
    return () => {
      dock.removeEventListener("dragover", onDragOver);
      dock.removeEventListener("drop", onDrop);
      dock.removeEventListener("paste", onPaste);
    };
  }, [session, conversation, client]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const picked = file || form.querySelector<HTMLInputElement>('input[type="file"]')?.files?.[0] || null;
    await uploadPicked(picked, form);
  }

  return (
    <form onSubmit={onSubmit} className="attach" aria-label="파일 첨부">
      <Label className="attach-clip">
        <span className="field-fallback">첨부 파일</span>
        <input
          type="file"
          aria-label="첨부 파일"
          onChange={(e) => {
            const picked = e.target.files?.[0] || null;
            setFile(picked);
            uploadPicked(picked, e.target.form);
          }}
        />
      </Label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" className="field-fallback" disabled={pending}>
        첨부
      </Button>
    </form>
  );
}
