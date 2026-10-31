import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session, TicketLabel } from "../store.js";

type Canned = { id?: string; short_code?: string };
type Macro = { id?: string; name?: string };

type CatalogSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

export function CatalogSettings({ session, client }: CatalogSettingsProps) {
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  const [canned, setCanned] = useState<Canned[]>([]);
  const [labelName, setLabelName] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [content, setContent] = useState("");
  const [macros, setMacros] = useState<Macro[]>([]);
  const [macroName, setMacroName] = useState("");
  const [macroMessage, setMacroMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.listAccountLabels
        ? client.listAccountLabels({
            gatewayUrl: session.gatewayUrl,
            accountId: session.accountId,
            token: session.token,
          })
        : Promise.resolve({ labels: [] }),
      client.listCanned
        ? client.listCanned({
            gatewayUrl: session.gatewayUrl,
            accountId: session.accountId,
            token: session.token,
          })
        : Promise.resolve({ canned_responses: [] }),
      client.listMacros
        ? client.listMacros({
            gatewayUrl: session.gatewayUrl,
            accountId: session.accountId,
            token: session.token,
          })
        : Promise.resolve({ macros: [] }),
    ])
      .then(([labelData, cannedData, macroData]) => {
        if (!cancelled) {
          setLabels(labelData?.labels || []);
          setCanned(cannedData?.canned_responses || []);
          setMacros(macroData?.macros || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  async function onCreateLabel(e: FormEvent) {
    e.preventDefault();
    if (!client.createAccountLabel || !labelName.trim()) {
      return;
    }
    setError("");
    try {
      const created = await client.createAccountLabel({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: labelName.trim(),
      });
      setLabels((prev) => [...prev, created]);
      setLabelName("");
    } catch {
      setError("라벨을 만들지 못했습니다");
    }
  }

  async function onCreateCanned(e: FormEvent) {
    e.preventDefault();
    if (!client.createCanned || !shortCode.trim() || !content.trim()) {
      return;
    }
    setError("");
    try {
      const created = await client.createCanned({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        shortCode: shortCode.trim(),
        content: content.trim(),
      });
      setCanned((prev) => [...prev, created]);
      setShortCode("");
      setContent("");
    } catch {
      setError("저장응답을 만들지 못했습니다");
    }
  }

  async function onCreateMacro(e: FormEvent) {
    e.preventDefault();
    if (!client.createMacro || !macroName.trim() || !macroMessage.trim()) {
      return;
    }
    setError("");
    try {
      const created = await client.createMacro({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: macroName.trim(),
        visibility: "account",
        actions: [{ action_name: "send_message", action_params: [macroMessage.trim()] }],
      });
      setMacros((prev) => [...prev, created]);
      setMacroName("");
      setMacroMessage("");
    } catch {
      setError("매크로를 만들지 못했습니다");
    }
  }

  async function onDeleteLabel(label: TicketLabel) {
    if (!client.deleteAccountLabel || !label?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteAccountLabel({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        labelId: label.id,
      });
      setLabels((prev) => prev.filter((row) => row.id !== label.id));
    } catch {
      setError("라벨을 삭제하지 못했습니다");
    }
  }

  async function onDeleteCanned(row: Canned) {
    if (!client.deleteCanned || !row?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteCanned({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        canned_id: row.id,
      });
      setCanned((prev) => prev.filter((item) => item.id !== row.id));
    } catch {
      setError("저장응답을 삭제하지 못했습니다");
    }
  }

  async function onDeleteMacro(macro: Macro) {
    if (!client.deleteMacro || !macro?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteMacro({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        macroId: macro.id,
      });
      setMacros((prev) => prev.filter((item) => item.id !== macro.id));
    } catch {
      setError("매크로를 삭제하지 못했습니다");
    }
  }

  return (
    <section className="settings-resource" aria-label="카탈로그">
      <h2>라벨·저장응답·매크로</h2>
      <div className="settings-block">
        <h3>라벨</h3>
        <ul className="settings-list">
          {labels.map((l) => (
            <li key={l.id || l.name}>
              <span className="settings-item-main">{l.name}</span>
              {client.deleteAccountLabel && l.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onDeleteLabel(l)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={onCreateLabel} className="flex flex-col gap-2">
          <Label>
            카탈로그 라벨
            <Input value={labelName} onChange={(e) => setLabelName(e.target.value)} required />
          </Label>
          <Button type="submit">라벨 추가</Button>
        </form>
      </div>
      <div className="settings-block">
        <h3>저장응답</h3>
        <ul className="settings-list">
          {canned.map((c) => (
            <li key={c.id || c.short_code}>
              <span className="settings-item-main">/{c.short_code}</span>
              {client.deleteCanned && c.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onDeleteCanned(c)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={onCreateCanned} className="flex flex-col gap-2">
          <Label>
            short_code
            <Input value={shortCode} onChange={(e) => setShortCode(e.target.value)} required />
          </Label>
          <Label>
            저장응답
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} required />
          </Label>
          <Button type="submit">저장응답 추가</Button>
        </form>
      </div>
      <div className="settings-block">
        <h3>매크로</h3>
        <ul className="settings-list">
          {macros.map((m) => (
            <li key={m.id || m.name}>
              <span className="settings-item-main">{m.name}</span>
              {client.deleteMacro && m.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onDeleteMacro(m)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {client.createMacro ? (
          <form onSubmit={onCreateMacro} className="flex flex-col gap-2">
            <Label>
              매크로 이름
              <Input value={macroName} onChange={(e) => setMacroName(e.target.value)} required />
            </Label>
            <Label>
              공개 메시지
              <Textarea value={macroMessage} onChange={(e) => setMacroMessage(e.target.value)} required />
            </Label>
            <Button type="submit">매크로 저장</Button>
          </form>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
