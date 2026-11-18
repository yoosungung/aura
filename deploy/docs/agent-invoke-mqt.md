# `agent_invoke` MQT · `aura.stream.<run_id>` 프레임 (M3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #10 · #11 · #13 · §3.2 · §3.5 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
내부: [`../../services/agent-invoke/DESIGN.md`](../../services/agent-invoke/DESIGN.md).  
주입: [`agent-inject-contract.md`](agent-inject-contract.md).  
resolve wire: [`svc-control-resolve.md`](svc-control-resolve.md).

**이 문서 범위:** 태스크 payload · 스트림 프레임 타입 · RPC 순서 · done/error envelope · MQT 이름표 · **우회 쿼터 재확인**.  
**Non-goals:** live LLM Gateway · live NATS Core publisher 구현 · `mcp_invoke` 이원화 · resolve 브리지 Deployment · 체크포인트 DDL · Gateway Token Bucket 본구현.  
Gateway SSE/WS·`run_id`·principal·Fair Queue: [`gateway-sse-ws.md`](gateway-sse-ws.md) · [`gateway-fair-queue.md`](gateway-fair-queue.md).

---

## MQT 이름표 (§3.2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.agent.invoke` |
| consumer | `aura_agent_invoke` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.agent.invoke.done` |
| errorTopic | `aura.events.agent.invoke.error` |
| scale | `minReplicaCount=0` (async scale-to-zero) |

매니페스트: [`../k8s/agent-invoke/`](../k8s/agent-invoke/).

---

## 태스크 payload (§7)

식별자만. `bundle` / `cfg` / `secrets` plaintext 금지.

```json
{
  "run_id": "<uuidv7>",
  "agent": "demo",
  "version": "1.0.0",
  "input": { "text": "…" },
  "session_id": "…",
  "stream": true,
  "principal": { "id": "…", "tenant_id": "…" }
}
```

| 규칙 | 내용 |
|------|------|
| `run_id` | Gateway(또는 제출자) 발급. 스트림 subject 키 |
| `stream` | 기본 `true`(대화형). `false`면 Core 프레임 생략(배치) |
| `principal.tenant_id` | 필수 — resolve/recall·쿼터 테넌트 키 |
| 쿼터 재확인 | injectable `rateLimiter.ensureAdmitted` — Gateway 우회 publish 방어(§2.2); 초과 시 errorTopic·재큐 금지 | 

선택: `input.tool = { server, name, arguments }` → 턴 중 `aura.rpc.mcp.tool` 1회(스켈레톤).

---

## 실행 순서

1. **validate** — identifiers-only · `run_id`/`agent`/`version`/`principal`  
2. **`aura.rpc.control.resolve`** — `cfg` + `secrets_ref` only (plaintext secrets 거부)  
3. **`stream !== false`** → `run.started` on `aura.stream.<run_id>`  
4. **`aura.rpc.memory.recall`** → `items[]`만 패킹(슬롯 예산; spill 금지)  
5. **turn** — 토큰 프레임; 선택 tool → `tool.started` / `tool.finished`  
6. **`run.completed`** (스트림일 때)  
7. **done envelope** → MQT respTopic (`type: agent.invoke.done`)

실패 → 비-2xx → MQT `errorTopic` (`type: agent.invoke.error`). 스트림상 `error` 프레임은 힌트일 뿐 — **정본은 events**.

---

## 스트림 프레임 계약 (§3.5 · V3.1)

Subject: **`aura.stream.<run_id>`** — NATS **Core** only. JetStream/`AURA_EVENTS`에 토큰 금지.

| `type` | 필드 | 규칙 |
|--------|------|------|
| `run.started` | `run_id`, `session_id`, `agent`, `version` | 턴 시작 직후 |
| `token` | `text` | incremental·슬림; **done 이전** 필수(대화형) |
| `tool.started` | `tool`, `server?` | 툴 시작 |
| `tool.finished` | `tool`, `server?`, `summary?` | 툴 종료 |
| `error` | `message` | UX 힌트; 정본=`aura.events.agent.invoke.error` |
| `run.completed` | (없음/최소) | 스트림 종료 신호; **내구 완료는 events done** |

**V3.1:** 첫 `token` 또는 `tool.started`가 `run.completed` / events done **이전**.

---

## Done envelope (§8)

```json
{
  "id": "<run_id>",
  "type": "agent.invoke.done",
  "tenant_id": "…",
  "occurred_at": "…",
  "payload": {
    "run_id": "…",
    "session_id": null,
    "agent": "demo",
    "version": "1.0.0",
    "stream": true,
    "output": { "text": "…" }
  },
  "content_ref": null
}
```

---

## 검증

```bash
./deploy/scripts/check-agent-invoke.sh
node services/agent-invoke/handler.selftest.js
```
