import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";

export function MCPSettings({ session, client }) {
  const [servers, setServers] = useState([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client.listMCP) {
      return undefined;
    }
    let cancelled = false;
    client
      .listMCP({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setServers(data?.mcp_servers || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  async function onCreate(e) {
    e.preventDefault();
    if (!client.upsertMCP || !name.trim() || !url.trim()) {
      return;
    }
    setError("");
    try {
      const created = await client.upsertMCP({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: name.trim(),
        url: url.trim(),
        auth_header: auth.trim(),
      });
      setServers((prev) => [...prev.filter((s) => s.name !== created.name), created]);
      setName("");
      setUrl("");
      setAuth("");
    } catch {
      setError("MCP 서버를 저장하지 못했습니다");
    }
  }

  async function onRotate() {
    const target = servers[0];
    if (!client.rotateMCP || !target?.id || !auth.trim()) {
      return;
    }
    setError("");
    try {
      const updated = await client.rotateMCP({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        mcp_server_id: target.id,
        auth_header: auth.trim(),
      });
      setServers((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
      setAuth("");
    } catch {
      setError("인증 헤더를 회전하지 못했습니다");
    }
  }

  return (
    <section className="catalog" aria-label="MCP">
      <h2>운영계 MCP</h2>
      <ul>
        {servers.map((s) => (
          <li key={s.id || s.name}>
            {s.name} {s.url} {revealed && s.auth_header ? s.auth_header : "••••••••"}
          </li>
        ))}
      </ul>
      <form onSubmit={onCreate} className="flex flex-col gap-2">
        <Label>
          MCP 이름
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Label>
        <Label>
          MCP URL
          <Input value={url} onChange={(e) => setUrl(e.target.value)} required />
        </Label>
        <Label>
          인증 헤더
          <Input value={auth} onChange={(e) => setAuth(e.target.value)} />
        </Label>
        <Button type="submit">MCP 추가</Button>
      </form>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={() => setRevealed(true)}>
          보기
        </Button>
        <Button type="button" variant="secondary" onClick={onRotate}>
          재발급
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
