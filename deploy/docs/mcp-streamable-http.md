# 외부 MCP Streamable HTTP 어댑터 (`mcp_invoke` 경계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #12 · §7.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
내부: [`../../services/mcp-invoke/DESIGN.md`](../../services/mcp-invoke/DESIGN.md) · [`mcp-invoke-dual.md`](mcp-invoke-dual.md).

**이 문서 범위:** MCP Spec **2025-06-18 Streamable HTTP** 클라이언트 어댑터 · `mcp_invoke` Function에서만 HTTP · Aura 컴포넌트 간은 NATS만.

**Non-goals:** Egress **실측** · LLM Gateway · F1 · **initialize/전체 세션 라이프사이클 서버** · legacy HTTP+SSE transport(후속/선택). (NATS mTLS → [`nats-mtls-secrets.md`](nats-mtls-secrets.md).)  
격리 **정책**(RuntimeClass/Egress allowlist): [`mcp-bundle-isolation.md`](mcp-bundle-isolation.md).

---

## 경계 (§1 #12)

| 구간 | 프로토콜 |
|------|----------|
| Aura 내부 (`agent_invoke` → `mcp_invoke`, 컴포넌트 간) | NATS Request-Reply / MQT만 |
| `mcp_invoke` → 테넌트·외부 MCP | **Streamable HTTP** (`tools/call` POST) |

MCP 프로토콜을 Gateway·memory·agent 경로에 두지 않는다. resolve가 `cfg.transport === 'streamable_http'` 또는 `cfg.mcp_endpoint`를 주면 공유 `handler`가 injectable `fetch`로 어댑터를 호출한다.

---

## Streamable HTTP (2025-06-18)

| 항목 | 값 |
|------|-----|
| 메서드 | 단일 엔드포인트 **POST** |
| `Accept` | `application/json, text/event-stream` |
| `Content-Type` | `application/json` |
| Body | JSON-RPC 2.0 메시지 1건 (`tools/call`) |
| 응답 | `application/json` **또는** `text/event-stream` (마지막 `data:` JSON-RPC 응답) |
| 세션 | (선택) `Mcp-Session-Id` — initialize 이후; 본 슬라이스는 **저장된 session id를 cfg로 전달**만 |
| 버전 | `MCP-Protocol-Version: 2025-06-18` |

JSON-RPC 요청 형태:

```json
{
  "jsonrpc": "2.0",
  "id": "…",
  "method": "tools/call",
  "params": { "name": "<tool>", "arguments": {} }
}
```

---

## resolve `cfg` (§7)

| 필드 | 의미 |
|------|------|
| `transport` | `streamable_http` 이면 HTTP 어댑터 |
| `mcp_endpoint` / `endpoint` | POST URL |
| `mcp_session_id` / `session_id` | (선택) `Mcp-Session-Id` |
| `mcp_protocol_version` | (선택) 기본 `2025-06-18` |

`secrets_ref`만 — plaintext `secrets` 금지. Authorization 등은 시크릿 로더(후속)가 헤더에 붙이며, 어댑터는 **Authorization을 로그하지 않는다**.

---

## 코드 · 배선

| 경로 | 역할 |
|------|------|
| [`services/mcp-invoke/streamable-http.js`](../../services/mcp-invoke/streamable-http.js) | `buildToolsCallRequest` · `parseJsonOrSseResponse` · `callToolViaStreamableHttp` |
| [`services/mcp-invoke/handler.js`](../../services/mcp-invoke/handler.js) | `deps.runTool` 없을 때 cfg 기준 어댑터; `context.fetchImpl` injectable |
| [`deploy/k8s/mcp-invoke/invoke.js`](../k8s/mcp-invoke/invoke.js) | Fission 단일 파일 번들 (`bundle-invoke.js`) |

`deps.runTool`이 있으면 stub/라이브 팩토리가 우선한다. 외부 HTTP는 **라이브 네트워크 스모크 Non-goal** — selftest는 fake `fetch`만.

---

## Commands

```bash
bash deploy/scripts/check-mcp-streamable-http.sh
node services/mcp-invoke/streamable-http.selftest.js
node services/mcp-invoke/bundle-invoke.js   # invoke.js + package literal 갱신
```