# Gateway (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #1 · #13 · #16 · §2 · §2.2 · §3.5 · §7.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — `run_id`/SSE/WS · **테넌트 Rate Limiting**.  
와이어: [`deploy/docs/gateway-sse-ws.md`](../../deploy/docs/gateway-sse-ws.md) · [`deploy/docs/gateway-fair-queue.md`](../../deploy/docs/gateway-fair-queue.md).

**이 문서 범위:** `run_id`(UUIDv7) · principal 레지스트리 · SSE/WS exact-subject 인가 · **Token Bucket + max_inflight(429)** · KV-shaped quota store.  
**Non-goals:** live NATS JetStream KV 클라이언트 · F1 subject 샤딩 · 우회 publish 재확인 · live LLM · sandbox · `mcp_invoke`.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 쿼터 검사 후 제출 수락 → `run_id` → `aura.tasks.agent.invoke` publish; Core `aura.stream.<run_id>` → SSE/WS |
| 실행 계급 | **상시 ≥2** (Deployment). Fission MQT / scale-to-zero **금지** |
| PG | **없음** |
| 인가 | `run_id` 소유 principal(`id`+`tenant_id`)만 구독 (그 외 403/404) |
| 쿼터 | `tenant_id` 키 · Token Bucket(`rate_per_sec`/`burst`) + `max_inflight` · 거부 **429** |
| 상태 | injectable `get`/`put` (테스트=`createMemoryQuotaStore`; 생산=NATS KV 권장) |
| 스트림 | exact `aura.stream.<run_id>` — 와일드카드 금지 |

---

## HTTP 표면

| 메서드 | 경로 | 의미 |
|--------|------|------|
| `POST` | `/v1/agent/invoke` | principal → **quota** → `run_id` → publish → **202** 또는 **429** |
| `GET` | `/v1/runs/:run_id/events` | SSE; 소유 principal만 |
| `GET` | `/v1/runs/:run_id/ws` | WebSocket; 동일 인가 |

기본 플랜: rate **10**/s · burst **30** · max_inflight **20** ([`gateway-fair-queue.md`](../../deploy/docs/gateway-fair-queue.md)).

---

## 모듈

| 파일 | 역할 |
|------|------|
| `gateway.js` | submit/SSE/WS + quota acquire 연동 |
| `rate-limit.js` | `acquireForRun` · `releaseInflight` · memory KV |
| `gateway.selftest.js` | UUIDv7 · 인가 · **노이지 픽스처(A 429 / B 202)** · 429 HTTP |

---

## Commands

```bash
bash deploy/scripts/check-gateway-sse-ws.sh
bash deploy/scripts/check-gateway-fair-queue.sh
node services/gateway/gateway.selftest.js
```
