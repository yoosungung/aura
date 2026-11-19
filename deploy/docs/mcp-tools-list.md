# MCP `tools/list` + `tools/call` (M3.5)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #11–#12 · §7.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.5.  
이원화: [`mcp-invoke-dual.md`](mcp-invoke-dual.md).  
Streamable HTTP: [`mcp-streamable-http.md`](mcp-streamable-http.md).

**이 문서 범위:** NATS RPC/태스크 payload의 **action** · Streamable HTTP `tools/list` JSON-RPC · Agent 바인딩.  
**Non-goals:** full MCP initialize 세션 서버 · legacy HTTP+SSE.

---

## Aura wire (`aura.rpc.mcp.tool` / `aura.tasks.mcp.invoke`)

식별자만. `action` 기본 = `call`.

**call** (기존):

```json
{
  "action": "call",
  "server": "demo-mcp",
  "version": "1.0.0",
  "tool": "echo",
  "arguments": { "x": 1 },
  "principal": { "id": "…", "tenant_id": "…" }
}
```

**list**:

```json
{
  "action": "list",
  "server": "demo-mcp",
  "version": "1.0.0",
  "principal": { "id": "…", "tenant_id": "…" }
}
```

| 규칙 | 내용 |
|------|------|
| `action=list` | `tool` **불필요**. 응답 `tools[]` = `{ name, description?, inputSchema? }[]` |
| `action=call` | `tool` 필수 (기존) |
| resolve | kind=`mcp` → `cfg` + `secrets_ref` |
| 외부 | cfg `transport=streamable_http` → JSON-RPC `tools/list` / `tools/call` |

**Sync reply (list):**

```json
{
  "type": "mcp.tool.done",
  "ok": true,
  "action": "list",
  "server": "demo-mcp",
  "version": "1.0.0",
  "tools": [{ "name": "echo", "description": "…", "inputSchema": {} }],
  "subject": "aura.rpc.mcp.tool"
}
```

---

## Streamable HTTP

| method | params |
|--------|--------|
| `tools/list` | `{}` (또는 스펙 허용 필터) |
| `tools/call` | `{ name, arguments }` (기존) |

---

## Agent 바인딩

`agent_invoke`는 턴 시작 시(또는 resolve cfg의 툴 목록 캐시) `action=list`로 스키마를 받고 LangChain `tool()`로 감싼 뒤 `createAgent({ tools })`에 넘긴다. 실행은 다시 `action=call`.

---

## 검증

```bash
node services/mcp-invoke/handler.selftest.js
node services/mcp-invoke/streamable-http.selftest.js
bash deploy/scripts/check-mcp-invoke-dual.sh
bash deploy/scripts/check-mcp-streamable-http.sh
```
