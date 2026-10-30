import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";

export function CatalogSettings({ session, client }) {
  const [labels, setLabels] = useState([]);
  const [canned, setCanned] = useState([]);
  const [labelName, setLabelName] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [content, setContent] = useState("");
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
    ])
      .then(([labelData, cannedData]) => {
        if (!cancelled) {
          setLabels(labelData?.labels || []);
          setCanned(cannedData?.canned_responses || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  async function onCreateLabel(e) {
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

  async function onCreateCanned(e) {
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

  return (
    <section className="catalog" aria-label="카탈로그">
      <h2>라벨·저장응답</h2>
      <ul>
        {labels.map((l) => (
          <li key={l.id || l.name}>{l.name}</li>
        ))}
      </ul>
      <form onSubmit={onCreateLabel} className="flex flex-col gap-2">
        <Label>
          카탈로그 라벨
          <Input value={labelName} onChange={(e) => setLabelName(e.target.value)} required />
        </Label>
        <Button type="submit">라벨 추가</Button>
      </form>
      <ul>
        {canned.map((c) => (
          <li key={c.id || c.short_code}>/{c.short_code}</li>
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
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
