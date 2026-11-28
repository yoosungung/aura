# LLM Gateway Fallback + 테넌트 과금 대시보드 (M5 · §9.4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.4.  
최소 경로: [`llm-gateway.md`](llm-gateway.md).  
내부: [`../../services/llm-gateway/DESIGN.md`](../../services/llm-gateway/DESIGN.md).

**이 문서 범위:** 순서 Fallback 모델 · `GET /v1/billing/usage` 테넌트 집계 · ops plain-text 대시보드.  
**Non-goals:** live 공급자 키 CI 필수 · PG/외부 invoice SoR · SPA UI · streaming SSE · 가중치 서빙.

---

## Fallback

1. Gateway는 주입 `providers[]`를 **순서대로** 시도한다 (`provider` 단일은 `[provider]`).
2. 후보별 **circuit**이 open이면 호출하지 않고 다음 후보로 skip.
3. 후보 실패(throw) → `recordFailure` 후 다음 후보.
4. `fallbackModels[requested]`가 있으면 2번째 이후 시도에 해당 **모델 id**를 쓴다.
5. 성공 응답에 `aura: { provider, model_requested, model_served, fallback_used, attempts[] }`를 붙인다.
6. 전 후보 실패 → **502** `all_providers_failed` + `attempts`. 단일 후보가 circuit만이면 **503** `circuit_open`(M3 호환).

---

## 테넌트 과금 대시보드

| 메서드 | 경로 | 의미 |
|--------|------|------|
| `GET` | `/v1/billing/usage` | usage 로그 → 테넌트별 `request_count` · tokens · `cost_usd` 집계 |
| — | `renderBillingDashboard(summary)` | ops plain-text 테이블(SPA 아님) |

쿼리(핸들러 filter): `tenant_id` · `from_ms` · `to_ms`.  
집계 SoR = in-process usage log(이상 탐지·테넌트 비용 가시화). 외부 청구 원장은 Non-goal.

---

## 검증

```bash
bash deploy/scripts/check-llm-gateway-fallback-billing.sh
cargo test -p aura-llm-gateway
cargo test -p aura-llm-gateway
```
