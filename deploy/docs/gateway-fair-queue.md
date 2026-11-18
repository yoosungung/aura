# Gateway · 테넌트 Fair Queue / Rate Limiting (M3 · §2.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #16 · §2.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
내부: [`../../services/gateway/DESIGN.md`](../../services/gateway/DESIGN.md).  
제출/SSE: [`gateway-sse-ws.md`](gateway-sse-ws.md).  
우회 재확인: [`gateway-inflight-release.md`](gateway-inflight-release.md) · [`agent-invoke-mqt.md`](agent-invoke-mqt.md) · [`../../services/agent-invoke/DESIGN.md`](../../services/agent-invoke/DESIGN.md).

**이 문서 범위:** Token Bucket + max_inflight · 쿼터 키/상태(CAS KV) · 429 · 노이지 픽스처 · `release` · **done/error inflight 감산** · **우회 시 `agent_invoke` 재확인**.  
**Non-goals:** live NATS JetStream KV 클라이언트 배선 · live NATS Core done 구독 Deployment · F1 subject 샤딩 · live LLM · sandbox.

---

## 집행 위치

1. 클라이언트 → Gateway `POST /v1/agent/invoke`.
2. Gateway가 `tenant_id`에 대해 **Token Bucket** + **max_inflight** 검사 (`rateLimiter.tryAcquire`).
3. 통과 시에만 `run_id` 등록 + `aura.tasks.agent.invoke` publish.
4. 거부 → **429** (`rate_limited` | `max_inflight_exceeded`) · JetStream 미적재 · `retry_after_ms`.
5. 완료/실패 시 `rateLimiter.release(tenant_id, run_id)` — **멱등** (스트림 terminal / events 훅).

---

## done / error → inflight 감산

| 훅 | 트리거 | 동작 |
|----|--------|------|
| 스트림 | `aura.stream.<run_id>` frame `run.completed` \| `error` | `openStreamBridge`가 첫 terminal에서 `release` (first-fire-wins) |
| 이벤트 | subject `aura.events.agent.invoke.done` \| `.error` | `releaseInflightFromEvent(subject, tenant_id, run_id)` |

- `release`는 `runs[run_id]` 기준으로 **멱등** — 스트림과 이벤트가 둘 다 와도 inflight는 1만 감산.
- live NATS 구독 Deployment 배선은 Non-goal; 헬퍼·계약·selftest가 정본.

---

## 우회 publish → `agent_invoke` 재확인 (§2.2 방어)

Gateway 없이 `aura.tasks.agent.invoke`에 직접 publish할 수 있다.

| 규칙 | 내용 |
|------|------|
| 진입 | `agent_invoke`가 injectable `rateLimiter.ensureAdmitted(tenant_id, run_id)`로 **동일 키** 재확인 |
| Gateway 경유 | 이미 `runs[run_id]`면 tryAcquire **멱등 통과**(토큰 추가 소모 없음) |
| 우회·초과 | `ok:false` → **poison/error** (`agent.invoke.error` · HTTP 4xx) · **재큐 금지** |
| 미주입 | 개발 stub만 허용. 생산 배선은 동일 KV(`quota.{tenant_id}`)를 Gateway와 공유 |

---

## 기본 플랜 수치 (M3 DESIGN 초안)

| 필드 | 값 | 비고 |
|------|-----|------|
| `ratePerSec` | **10** | 지속 토큰 충전 |
| `burst` | **30** | 버킷 상한 |
| `maxInflight` | **20** | 동시 `run_id` |

---

## 상태 저장 (CAS KV shape)

| 항목 | 계약 |
|------|------|
| 키 | `quota.{tenant_id}` |
| 값 | `{ tokens, updated_at_ms, inflight, runs: { [run_id]: true } }` |
| 백엔드 | **NATS JetStream KV 권장** — 본 슬라이스는 `get`/`cas` injectable (`createMemoryKv` 테스트용) |
| 금지 | Redis를 큐 대용으로 쓰지 않음(§1.1) |

---

## Fairness (V3.2)

- 버킷/inflight가 비면 **해당 테넌트만** 429 — 다른 `tenant_id` publish는 막지 않는다.
- 노이지 픽스처: A가 rate/inflight를 소진해도 B는 202 + publish 성공 (`gateway.selftest.js`).

---

## 모듈

| 심볼 | 역할 |
|------|------|
| `createTenantRateLimiter({ kv, limits, now })` | `tryAcquire` / `release` |
| `tryAcquire(tenant, runId)` | CAS 루프로 토큰 1 + inflight 1 예약; 동일 `run_id` 멱등 |
| `ensureAdmitted(tenant, runId)` | Gateway 경유 멱등 또는 우회 acquire; 실패 429 |
| `release(tenant, runId)` | 멱등 감산 |
| `submitAgentInvoke` | tryAcquire 실패 시 publish 금지; publish 실패 시 release |
| `openStreamBridge` | terminal frame → release |
| `releaseInflightFromEvent` | done/error subject → release |
| `agent_invoke` `rateLimiter` | 우회 재확인 (동일 KV) |

---

## 검증

```bash
bash deploy/scripts/check-gateway-fair-queue.sh
node services/gateway/gateway.selftest.js
node services/agent-invoke/handler.selftest.js
```
