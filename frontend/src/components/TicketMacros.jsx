import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";

export function TicketMacros({ session, conversation, client, onRan }) {
  const [macros, setMacros] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [label, setLabel] = useState("");
  const [resolve, setResolve] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!client.listMacros) {
      return undefined;
    }
    let cancelled = false;
    client
      .listMacros({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setMacros(data?.macros || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  async function run(macroId) {
    if (!client.executeMacro) {
      return;
    }
    setError("");
    setPending(macroId);
    try {
      const data = await client.executeMacro({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        macroId,
      });
      onRan?.(data);
    } catch {
      setError("매크로를 실행하지 못했습니다");
    } finally {
      setPending("");
    }
  }

  async function onCreate(e) {
    e.preventDefault();
    if (!client.createMacro || !name.trim()) {
      return;
    }
    const actions = [];
    if (message.trim()) {
      actions.push({ action_name: "send_message", action_params: [message.trim()] });
    }
    if (label.trim()) {
      actions.push({ action_name: "add_label", action_params: [label.trim()] });
    }
    if (resolve) {
      actions.push({ action_name: "resolve_conversation", action_params: [] });
    }
    if (actions.length === 0) {
      return;
    }
    setError("");
    try {
      const created = await client.createMacro({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: name.trim(),
        visibility: session.role === "administrator" ? "account" : "personal",
        actions,
      });
      setMacros((prev) => [...prev, created]);
      setName("");
      setMessage("");
      setLabel("");
      setResolve(false);
    } catch {
      setError("매크로를 만들지 못했습니다");
    }
  }

  if (!client.listMacros && !client.createMacro) {
    return null;
  }

  return (
    <section className="macros" aria-label="매크로">
      {macros.length > 0 ? (
        <ul>
          {macros.map((m) => (
            <li key={m.id} className="flex items-center gap-2">
              <span>{m.name}</span>
              <Button type="button" size="sm" disabled={pending === m.id} onClick={() => run(m.id)}>
                실행
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {client.createMacro ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setCreating((v) => !v)}>
          매크로 만들기
        </Button>
      ) : null}
      {client.createMacro && creating ? (
        <form onSubmit={onCreate} className="flex flex-col gap-2">
          <Label>
            매크로 이름
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Label>
          <Label>
            공개 메시지
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} />
          </Label>
          <Label>
            라벨
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Label>
          <Label className="flex items-center gap-2">
            <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
            해결
          </Label>
          <Button type="submit">매크로 저장</Button>
        </form>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
