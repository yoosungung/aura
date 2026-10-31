import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session, TicketLabel } from "../store.js";

type Canned = { id?: string; short_code?: string; content?: string };
type MacroAction = { action_name?: string; action_params?: string[] };
type Macro = { id?: string; name?: string; actions?: MacroAction[] };

type CatalogSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

function macroMessage(macro: Macro) {
  const action = (macro.actions || []).find((a) => a.action_name === "send_message");
  return action?.action_params?.[0] || "";
}

export function CatalogSettings({ session, client }: CatalogSettingsProps) {
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  const [canned, setCanned] = useState<Canned[]>([]);
  const [labelName, setLabelName] = useState("");
  const [editingLabelId, setEditingLabelId] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [content, setContent] = useState("");
  const [editingCannedId, setEditingCannedId] = useState("");
  const [macros, setMacros] = useState<Macro[]>([]);
  const [macroName, setMacroName] = useState("");
  const [macroMessageText, setMacroMessageText] = useState("");
  const [editingMacroId, setEditingMacroId] = useState("");
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

  async function onSaveLabel(e: FormEvent) {
    e.preventDefault();
    if (!labelName.trim()) {
      return;
    }
    setError("");
    try {
      if (editingLabelId && client.updateAccountLabel) {
        const updated = await client.updateAccountLabel({
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          labelId: editingLabelId,
          name: labelName.trim(),
        });
        setLabels((prev) => prev.map((row) => (row.id === editingLabelId ? { ...row, ...updated } : row)));
        setEditingLabelId("");
        setLabelName("");
        return;
      }
      if (!client.createAccountLabel) {
        return;
      }
      const created = await client.createAccountLabel({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: labelName.trim(),
      });
      setLabels((prev) => [...prev, created]);
      setLabelName("");
    } catch {
      setError(editingLabelId ? "라벨을 수정하지 못했습니다" : "라벨을 만들지 못했습니다");
    }
  }

  async function onSaveCanned(e: FormEvent) {
    e.preventDefault();
    if (!shortCode.trim() || !content.trim()) {
      return;
    }
    setError("");
    try {
      if (editingCannedId && client.updateCanned) {
        const updated = await client.updateCanned({
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          canned_id: editingCannedId,
          shortCode: shortCode.trim(),
          content: content.trim(),
        });
        setCanned((prev) => prev.map((row) => (row.id === editingCannedId ? { ...row, ...updated } : row)));
        setEditingCannedId("");
        setShortCode("");
        setContent("");
        return;
      }
      if (!client.createCanned) {
        return;
      }
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
      setError(editingCannedId ? "저장응답을 수정하지 못했습니다" : "저장응답을 만들지 못했습니다");
    }
  }

  async function onSaveMacro(e: FormEvent) {
    e.preventDefault();
    if (!macroName.trim() || !macroMessageText.trim()) {
      return;
    }
    const actions = [{ action_name: "send_message", action_params: [macroMessageText.trim()] }];
    setError("");
    try {
      if (editingMacroId && client.updateMacro) {
        const updated = await client.updateMacro({
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          macroId: editingMacroId,
          name: macroName.trim(),
          visibility: "account",
          actions,
        });
        setMacros((prev) => prev.map((row) => (row.id === editingMacroId ? { ...row, ...updated } : row)));
        setEditingMacroId("");
        setMacroName("");
        setMacroMessageText("");
        return;
      }
      if (!client.createMacro) {
        return;
      }
      const created = await client.createMacro({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: macroName.trim(),
        visibility: "account",
        actions,
      });
      setMacros((prev) => [...prev, created]);
      setMacroName("");
      setMacroMessageText("");
    } catch {
      setError(editingMacroId ? "매크로를 수정하지 못했습니다" : "매크로를 만들지 못했습니다");
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
      if (editingLabelId === label.id) {
        setEditingLabelId("");
        setLabelName("");
      }
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
      if (editingCannedId === row.id) {
        setEditingCannedId("");
        setShortCode("");
        setContent("");
      }
    } catch {
      setError("저장응답을 삭제하지 못했습니다");
    }
  }

  function selectLabel(label: TicketLabel) {
    setEditingLabelId(label.id || "");
    setLabelName(label.name || "");
  }

  function selectCanned(row: Canned) {
    setEditingCannedId(row.id || "");
    setShortCode(row.short_code || "");
    setContent(row.content || "");
  }

  function selectMacro(macro: Macro) {
    setEditingMacroId(macro.id || "");
    setMacroName(macro.name || "");
    setMacroMessageText(macroMessage(macro));
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
      if (editingMacroId === macro.id) {
        setEditingMacroId("");
        setMacroName("");
        setMacroMessageText("");
      }
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="settings-item-main justify-start"
                aria-current={l.id && l.id === editingLabelId ? "true" : undefined}
                onClick={() => selectLabel(l)}
              >
                {l.name}
              </Button>
              {client.updateAccountLabel && l.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => selectLabel(l)}>
                  수정
                </Button>
              ) : null}
              {client.deleteAccountLabel && l.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onDeleteLabel(l)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={onSaveLabel} className="flex flex-col gap-2">
          <Label>
            카탈로그 라벨
            <Input value={labelName} onChange={(e) => setLabelName(e.target.value)} required />
          </Label>
          <div className="settings-form-actions">
            <Button type="submit" size="sm">
              {editingLabelId ? "라벨 저장" : "라벨 추가"}
            </Button>
          </div>
        </form>
      </div>
      <div className="settings-block">
        <h3>저장응답</h3>
        <ul className="settings-list">
          {canned.map((c) => (
            <li key={c.id || c.short_code}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="settings-item-main justify-start"
                aria-current={c.id && c.id === editingCannedId ? "true" : undefined}
                onClick={() => selectCanned(c)}
              >
                /{c.short_code}
              </Button>
              {client.updateCanned && c.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => selectCanned(c)}>
                  수정
                </Button>
              ) : null}
              {client.deleteCanned && c.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onDeleteCanned(c)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={onSaveCanned} className="flex flex-col gap-2">
          <Label>
            short_code
            <Input value={shortCode} onChange={(e) => setShortCode(e.target.value)} required />
          </Label>
          <Label>
            저장응답
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} required />
          </Label>
          <div className="settings-form-actions">
            <Button type="submit" size="sm">
              {editingCannedId ? "저장응답 저장" : "저장응답 추가"}
            </Button>
          </div>
        </form>
      </div>
      <div className="settings-block">
        <h3>매크로</h3>
        <ul className="settings-list">
          {macros.map((m) => (
            <li key={m.id || m.name}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="settings-item-main justify-start"
                aria-current={m.id && m.id === editingMacroId ? "true" : undefined}
                onClick={() => selectMacro(m)}
              >
                {m.name}
              </Button>
              {client.updateMacro && m.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => selectMacro(m)}>
                  수정
                </Button>
              ) : null}
              {client.deleteMacro && m.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onDeleteMacro(m)}>
                  삭제
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {client.createMacro || client.updateMacro ? (
          <form onSubmit={onSaveMacro} className="flex flex-col gap-2">
            <Label>
              매크로 이름
              <Input value={macroName} onChange={(e) => setMacroName(e.target.value)} required />
            </Label>
            <Label>
              공개 메시지
              <Textarea value={macroMessageText} onChange={(e) => setMacroMessageText(e.target.value)} required />
            </Label>
            <div className="settings-form-actions">
              <Button type="submit" size="sm">
                매크로 저장
              </Button>
            </div>
          </form>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
