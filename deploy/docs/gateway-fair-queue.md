# Gateway · 테넌트 Fair Queue / Rate Limiting (M3 · §2.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #16 · §2.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
내부: [`../../services/gateway/DESIGN.md`](../../services/gateway/DESIGN.md).  
제출/SSE: [`gateway-sse-ws.md`](gateway-sse-ws.md).  
**done/error 감산 · 우회 재확인:** [`gateway-inflight-release.md`](gateway-inflight-release.md).

**이 문서 범위:** Token Bucket + max_inflight · 쿼터 키/상태(CAS KV) · 429 · 노이지 픽스처 · `tryAcquire`/`release` API.  
**Non-goals:** live NATS JetStream KV 클라이언트 배선 · done/error 구독 Deployment · F1 subject 샤딩 · live LLM · sandbox.  
terminal `release` / `ensureAdmitted` 우회 재확인은 [`gateway-inflight-release.md`](gateway-inflight-release.md).

---

## 집행 위치

1. 클라이언트 → Gateway `POST /v1/agent/invoke`.
2. Gateway가 `tenant_id`에 대해 **Token Bucket** + **max_inflight** 검사 (`rateLimiter.tryAcquire`).
3. 통과 시에만 `run_id` 등록 + `aura.tasks.agent.invoke` publish.
4. 거부 → **429** (`rate_limited` | `max_inflight_exceeded`) · JetStream 미적재 · `retry_after_ms`.
5. 완료/실패 시 `rateLimiter.release(tenant_id, run_id)` — 상세 훅은 [`gateway-inflight-release.md`](gateway-inflight-release.md).

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
| `createTenantRateLimiter({ kv, limits, now })` | `tryAcquire` / `release` / `ensureAdmitted` |
| `tryAcquire(tenant, runId)` | CAS 루프로 토큰 1 + inflight 1 예약; 동일 `run_id` 멱등 |
| `release(tenant, runId)` | 멱등 감산 |
| `submitAgentInvoke` | tryAcquire 실패 시 publish 금지; publish 실패 시 release |

---

## 검증

```bash
bash deploy/scripts/check-gateway-fair-queue.sh
bash deploy/scripts/check-gateway-inflight-release.sh
node services/gateway/gateway.selftest.js
```
