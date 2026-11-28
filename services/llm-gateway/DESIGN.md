# LLM Gateway (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §9.4 · Function→공급자 **직접 금지**.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 최소 · **M5 Fallback + 테넌트 과금 대시보드** · **M5.1 콘텐츠 라우터**.  
와이어: [`deploy/docs/llm-gateway.md`](../../deploy/docs/llm-gateway.md) · [`deploy/docs/llm-gateway-fallback-billing.md`](../../deploy/docs/llm-gateway-fallback-billing.md) · [`deploy/docs/llm-gateway-router.md`](../../deploy/docs/llm-gateway-router.md).  
Egress NP: [`deploy/docs/egress-block-verify.md`](../../deploy/docs/egress-block-verify.md) (`app: aura-llm-gateway`).

**이 문서 범위:** OpenAI 호환 `POST /v1/chat/completions` · 테넌트 rate limit · provider circuit · **ordered Fallback** · **`aura-auto` 휴리스틱 티어 라우팅** · usage/cost 로그 · **`GET /v1/billing/usage`** · Function 클라이언트 egress 가드.  
**Non-goals:** live provider API 키를 CI PASS 조건으로 두지 않음 · 가중치 서빙 · streaming SSE 본배선 · PG/외부 invoice ledger · SPA · 학습형 분류기 · 품질 cascade · 전 트래픽 강제 라우팅.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | Function·`agent_invoke`/`memory_capture` 등 → **클러스터 LLM Gateway만** → 공급자 |
| 실행 계급 | **상시 ≥2** Deployment (`aura-llm-gateway`). Fission MQT / scale-to-zero **금지** |
| 이미지 | `aura/llm-gateway:local` · `gateway.js`·`providers.js`·`router.js` 베이크 · 카탈로그 파일 없으면 stub · `dev.orbstack.icon` · `node -e` 금지 |
| Rust (Phase 2B) | `rs/` (`aura-llm-gateway`) · `parity_tests.rs` · distroless · aura-auto/Fallback/billing stub · **`client.js`/`client.py` 유지** · live provider=canary |
| PG | **없음** |
| 라벨 | `app: aura-llm-gateway` (샌드박스 NP allow peer) |
| 금지 | Function→`api.openai.com` 등 공급자 **직접** (`client.js` + NP) |

---

## HTTP 표면

| 메서드 | 경로 | 의미 |
|--------|------|------|
| `GET` | `/healthz` | readiness |
| `POST` | `/v1/chat/completions` | 테넌트 쿼터 → (**`aura-auto`면 라우트**) → Fallback chain(circuit skip) → usage log |
| `POST` | `/v1/embeddings` | ConfigMap `embeddings` → OpenAI `POST {baseUrl}/embeddings` (미설정 시 **503** `embeddings_not_configured`) |
| `GET` | `/v1/billing/usage` | 테넌트별 tokens/`cost_usd` 집계 |

헤더: `X-Aura-Tenant-Id` (chat 필수). 선택 `X-Aura-Route-Pin: simple|medium|complex` (하향 금지).  
본문: `{ model, messages[] }` (OpenAI chat 최소).  
성공 chat 응답에 `aura.fallback_used` · `aura.attempts[]` · (`aura-auto`면) `aura.route` 포함.

---

## 콘텐츠 라우팅 (`router.js`)

| 항목 | 값 |
|------|-----|
| 가상 모델 | `aura-auto`만 opt-in. 구체 model id는 핀(§1 #18 `cfg.model` 유지) |
| 분류 | 프로세스 내 휴리스틱(길이·code/math/다단계 키워드·턴 수·tool 흔적). **추가 LLM 호출 없음** |
| 티어 | `simple` < `medium` < `complex` |
| 매핑 | ConfigMap `routing.tiers` · 빈 티어는 상위→하위 escalate |
| Pin | 호출자 헤더/`route_pin` — sticky replica·PG 금지 |
| Fallback | 라우팅 **이후** 기존 `providers[]` 체인 |

---

## 모듈

| 파일 | 역할 |
|------|------|
| `gateway.js` | `createLlmGateway` · stub · bucket RL · circuit · **providers[] Fallback** · route resolve · usage · `handleBillingUsage` · `renderBillingDashboard` |
| `router.js` | `scorePrompt` · `resolveRoute` · 티어 순위·매핑 |
| `client.js` / `client.py` | Function egress 가드 · `chatCompletions` / `chat_completions` · `X-Aura-Route-Pin` (Node·Python 패리티) |
| `providers.js` | ConfigMap JSON → `stub`/`ollama`/`openai`/`vllm`/`sglang` · `loadRoutingConfig` |
| `entrypoint.js` | HTTP 배선 · `AURA_LLM_PROVIDERS_FILE` 없으면 stub |
| `gateway.selftest.js` | egress · 429 · circuit · **fallback** · **billing** · **aura-auto 라우트/pin** |

기본 쿼터: rate **20**/s · burst **40** (`DEFAULT_LLM_LIMITS`).  
Deps: `providers[]` (또는 단일 `provider`) · `fallbackModels` · `routing` (`tiers`).

---

## Provider catalog (ConfigMap)

라우팅만 ConfigMap `aura-llm-gateway-providers` 키 `providers.json`. API 키는 Secret이고, 항목의 `apiKeyEnv`가 그 env 이름을 가리킨다. 가중치 호스팅은 하지 않는다. 파일이 없으면 프로세스 기본은 stub (CI). lab ConfigMap 기본은 `kind: ollama`, `model: gemma4:e2b-mlx`, `baseUrl: http://host.orb.internal:11434/v1`.

| kind | 호출 | 기본 `baseUrl` | 기본 model |
|------|------|----------------|------------|
| `stub` | 프로세스 내 | — | — |
| `ollama` | OpenAI `POST {baseUrl}/chat/completions` | ConfigMap 기본 `http://host.orb.internal:11434/v1` (OrbStack 호스트 Ollama; kind 코드 기본은 `ollama.aura.svc…:11434/v1`) | `gemma4:e2b` |
| `openai` | 동일 | `https://api.openai.com/v1` | 요청 model |
| `vllm` | 동일 (vLLM OpenAI 서버, 기본 포트 **8000**) | `http://vllm.aura.svc.cluster.local:8000/v1` | 요청 model |
| `sglang` | 동일 (SGLang HTTP, 기본 포트 **30000**) | `http://sglang.aura.svc.cluster.local:30000/v1` | 요청 model |

`model`이 있으면 그 provider는 요청 model 대신 고정한다. `kind`가 위 표 밖이면 `provider_kind_invalid`. 순서 = Fallback 순서.

선택 키 `embeddings`: `{ name?, kind, model, baseUrl?, apiKeyEnv? }`. lab 기본은 `ollama` / `embeddinggemma-2:270m-mxfp8-text` / `http://host.orb.internal:11434/v1`. 없으면 `/v1/embeddings` → 503.

선택 키 `routing.tiers`: `{ simple, medium, complex }` → model id. lab은 동일 ollama model로 채워 티어 메타만 기록.

---

## Commands

```bash
bash deploy/scripts/build-gateway-images.sh
bash deploy/scripts/check-llm-gateway.sh
bash deploy/scripts/check-llm-gateway-fallback-billing.sh
bash deploy/scripts/check-llm-gateway-router.sh
node services/llm-gateway/gateway.selftest.js
cargo test -p aura-llm-gateway
docker build -f services/llm-gateway/rs/Dockerfile -t aura/llm-gateway:local .
```
