# Gateway (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #1 · #13 · §2 · §2.2(집행 위치) · §3.5 · §7.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — Gateway `run_id` 발급 · SSE/WS 브리지 · principal 인가.  
와이어 정본: [`deploy/docs/gateway-sse-ws.md`](../../deploy/docs/gateway-sse-ws.md).  
업스트림 프레임: [`deploy/docs/agent-invoke-mqt.md`](../../deploy/docs/agent-invoke-mqt.md).

**이 문서 범위:** `run_id`(UUIDv7) 발급 · 소유 principal 레지스트리 · `aura.tasks.agent.invoke` publish · `aura.stream.<run_id>` → SSE/WS 브리지 · exact-subject 인가.  
**Non-goals (본 슬라이스):** Fair Queue / Token Bucket / max_inflight(§2.2 수치) · NATS KV 공유 상태 · live NATS 클라이언트 배선 · live LLM Gateway · `mcp_invoke` · `aura.rpc.control.resolve` 브리지 · `agent_checkpoints` DDL.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 클라이언트 제출 수락 → `run_id` 발급 → 태스크 publish; Core 스트림을 SSE/WS로 중계 |
| 실행 계급 | **상시 ≥2** (Deployment). Fission MQT / scale-to-zero **금지** |
| PG | **없음** (Zero Direct Write). Gateway는 Pooler/PG에 붙지 않는다 |
| 스트림 | 구독 subject = **exact** `aura.stream.<run_id>` — `*`/`>` 와일드카드 금지 |
| 인가 | `run_id` 소유 `principal.id` + `tenant_id` 일치만 구독 허용 (그 외 403/404) |
| 주입 | `publishTask` · `subscribeStream` — 단위 테스트·체크는 in-memory; live NATS = 후속 |

---

## HTTP 표면 (초안)

| 메서드 | 경로 | 의미 |
|--------|------|------|
| `POST` | `/v1/agent/invoke` | principal 검증 → `run_id` 발급 → `aura.tasks.agent.invoke` publish → **202** `{ run_id, stream_subject }` |
| `GET` | `/v1/runs/:run_id/events` | SSE (`text/event-stream`); 소유 principal만 |
| `GET` | `/v1/runs/:run_id/ws` | WebSocket 업그레이드; 동일 인가 |

Rate limit 429 / inflight 감산은 **별 M3 티켓**.

---

## 모듈

| 파일 | 역할 |
|------|------|
| `gateway.js` | `issueRunId` · registry · `submitAgentInvoke` · `openStreamBridge` · SSE format · WS authorize |
| `gateway.selftest.js` | UUIDv7 · 소유 인가 403 · exact subject · V3.1 프레임 중계 · PG 금지 |

---

## Commands

```bash
bash deploy/scripts/check-gateway-sse-ws.sh
node services/gateway/gateway.selftest.js
```
