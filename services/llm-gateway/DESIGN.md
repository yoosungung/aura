# LLM Gateway (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §9.4 · Function→공급자 **직접 금지**.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — **LLM Gateway 최소 + Function Egress는 Gateway만**.  
와이어: [`deploy/docs/llm-gateway.md`](../../deploy/docs/llm-gateway.md).  
Egress NP: [`deploy/docs/egress-block-verify.md`](../../deploy/docs/egress-block-verify.md) (`app: aura-llm-gateway`).

**이 문서 범위:** OpenAI 호환 `POST /v1/chat/completions` · 테넌트 rate limit · provider circuit breaker · usage/cost 로그 · Function 클라이언트 egress 가드.  
**Non-goals:** Fallback 모델/과금 대시보드(M5) · live provider API 키를 CI PASS 조건으로 두지 않음 · 가중치 서빙 · streaming SSE 본배선.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | Function·`agent_invoke`/`memory_capture` 등 → **클러스터 LLM Gateway만** → 공급자 |
| 실행 계급 | **상시 ≥2** Deployment (`aura-llm-gateway`). Fission MQT / scale-to-zero **금지** |
| PG | **없음** |
| 라벨 | `app: aura-llm-gateway` (샌드박스 NP allow peer) |
| 금지 | Function→`api.openai.com` 등 공급자 **직접** (`client.js` + NP) |

---

## HTTP 표면

| 메서드 | 경로 | 의미 |
|--------|------|------|
| `GET` | `/healthz` |  readiness |
| `POST` | `/v1/chat/completions` | 테넌트 쿼터 → circuit → provider → usage log |

헤더: `X-Aura-Tenant-Id` (필수). 본문: `{ model, messages[] }` (OpenAI chat 최소).

---

## 모듈

| 파일 | 역할 |
|------|------|
| `gateway.js` | `createLlmGateway` · stub provider · bucket RL · circuit · usage |
| `client.js` | `createLlmGatewayClient` · `assertFunctionLlmEgress` (provider blocklist) |
| `gateway.selftest.js` | egress 가드 · 429 · circuit_open · usage |

기본 쿼터: rate **20**/s · burst **40** (`DEFAULT_LLM_LIMITS`).

---

## Commands

```bash
bash deploy/scripts/check-llm-gateway.sh
node services/llm-gateway/gateway.selftest.js
```
