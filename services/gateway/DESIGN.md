# Gateway (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #1 · #13 · #16 · §2 · §2.2 · §3.5 · §7.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — `run_id`/SSE/WS · **테넌트 Rate Limiting**.  
와이어: [`deploy/docs/gateway-sse-ws.md`](../../deploy/docs/gateway-sse-ws.md) · [`deploy/docs/gateway-fair-queue.md`](../../deploy/docs/gateway-fair-queue.md).

**이 문서 범위:** `run_id`(UUIDv7) · principal 레지스트리 · SSE/WS exact-subject 인가 · **Token Bucket + max_inflight(429)** · CAS KV quota · **done/error inflight `release`**.  
**Non-goals:** live NATS JetStream KV 클라이언트 · live done 구독 Deployment · F1 subject 샤딩 · live LLM · sandbox · `mcp_invoke`.  
우회 재확인은 [`../agent-invoke/DESIGN.md`](../agent-invoke/DESIGN.md) (`rateLimiter` 주입).

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 쿼터 검사 후 제출 수락 → `run_id` → `aura.tasks.agent.invoke` publish; Core `aura.stream.<run_id>` → SSE/WS |
| 실행 계급 | **상시** Deployment · **ns `aura`** (lab `replicas: 1`; HA ≥2). Fission MQT / scale-to-zero **금지** |
| 이미지 | `aura/gateway:local` · Rust distroless · `dev.orbstack.icon` |
| PG | **없음** |
| 인가 | `run_id` 소유 principal(`id`+`tenant_id`)만 구독 (그 외 403/404) |
| 쿼터 | `quota.{tenant_id}` 키 · Token Bucket(`ratePerSec`/`burst`) + `maxInflight` · 거부 **429** |
| 감산 | 스트림 `run.completed`/`error` · 이벤트 `aura.events.agent.invoke.done`/`error` → `release` (멱등) |
| 상태 | injectable `get`/`cas` (테스트=`MemoryKv`; 생산=NATS KV 권장) |
| 스트림 | exact `aura.stream.<run_id>` — 와일드카드 금지 |

---

## HTTP 표면

| 메서드 | 경로 | 의미 |
|--------|------|------|
| `POST` | `/v1/agent/invoke` | principal → **quota** → `run_id` → publish → **202** 또는 **429** |
| `GET` | `/v1/runs/:run_id/events` | SSE; 소유 principal만 |
| `GET` | `/v1/runs/:run_id/ws` | WebSocket; 동일 인가 |

기본 플랜: rate **10**/s · burst **30** · maxInflight **20** ([`gateway-fair-queue.md`](../../deploy/docs/gateway-fair-queue.md)).

---

## 모듈

| 파일 | 역할 |
|------|------|
| `src/lib.rs` | submit/SSE/WS + `try_acquire` · terminal `release` · `release_inflight_from_event` |
| `src/rate_limit.rs` | `TenantRateLimiter` · `try_acquire`/`release` · memory CAS KV |
| `src/main.rs` | axum HTTP 배선 |
| `src/parity_tests.rs` | UUIDv7 · 인가 · 노이지 · done/error 감산 · 429 |

---

## Commands

```bash
bash deploy/scripts/build-gateway-images.sh
bash deploy/scripts/check-gateway-sse-ws.sh
bash deploy/scripts/check-gateway-fair-queue.sh
bash deploy/scripts/check-gateway-inflight-release.sh
SMOKE_GATEWAY_AGENT_INVOKE_STATIC=1 bash deploy/scripts/smoke-gateway-agent-invoke.sh
bash deploy/scripts/smoke-gateway-agent-invoke.sh   # lab: in-cluster DNS → aura-gateway
cargo test -p aura-gateway
docker build -f services/gateway/Dockerfile -t aura/gateway:local .
```
