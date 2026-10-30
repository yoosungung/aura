import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Label } from "./ui/label.jsx";

export function TicketAttachments({ session, conversation, client, onAttached }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function uploadPicked(picked, form) {
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
    function pickedFile(bag) {
      return bag?.files?.[0] || null;
    }
    function onDragOver(e) {
      e.preventDefault();
    }
    function onDrop(e) {
      e.preventDefault();
      uploadPicked(pickedFile(e.dataTransfer));
    }
    function onPaste(e) {
      const picked = pickedFile(e.clipboardData);
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

  async function onSubmit(e) {
    e.preventDefault();
    const picked = file || e.currentTarget.querySelector('input[type="file"]')?.files?.[0];
    await uploadPicked(picked, e.currentTarget);
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
