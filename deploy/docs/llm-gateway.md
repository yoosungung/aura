# LLM Gateway 최소 (M3 · §9.4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.4.  
내부: [`../../services/llm-gateway/DESIGN.md`](../../services/llm-gateway/DESIGN.md).  
샌드박스 Egress: [`egress-block-verify.md`](egress-block-verify.md) · NP peer `app: aura-llm-gateway`.

**이 문서 범위:** Function Egress는 Gateway만 · `POST /v1/chat/completions` · 테넌트 rate limit · circuit breaker · 토큰·비용 로그.  
**M5 확장:** Fallback + 테넌트 과금 대시보드 → [`llm-gateway-fallback-billing.md`](llm-gateway-fallback-billing.md).  
**Non-goals:** live 공급자 키 CI 필수 · 모델 가중치 호스팅 · F1. (NATS mTLS·시크릿 mask/TTL → [`nats-mtls-secrets.md`](nats-mtls-secrets.md).)

---

## 집행 위치

1. Function / `agent_invoke` / `memory_capture` → **`createLlmGatewayClient`** (`baseUrl` = `http://aura-llm-gateway…:8080`만 허용).
2. Gateway: `X-Aura-Tenant-Id` + body → Token Bucket → circuit → injectable provider.
3. 공급자 직접 URL(`api.openai.com` 등) → 클라이언트 **생성 거부** (`provider_direct_forbidden`) + 샌드박스 NP **deny**.
4. 성공 시 usage 로그: `tenant_id` · tokens · `cost_usd` (과금 SoR 아님; 이상 탐지용).

---

## HTTP

| 메서드 | 경로 | 성공 | 거부 |
|--------|------|------|------|
| `POST` | `/v1/chat/completions` | **200** chat.completion | **400** validation · **429** `rate_limited` · **503** `circuit_open` · **502** provider |
| `POST` | `/v1/embeddings` | **200** embeddings list | **400** `input_required` · **503** `embeddings_not_configured` · **502** provider |
| `GET` | `/healthz` | **200** `ok` | — |

기본 쿼터: rate **20**/s · burst **40**.

---

## 배포

| 항목 | 값 |
|------|-----|
| Service DNS | `aura-llm-gateway.aura.svc.cluster.local:8080` |
| Deployment | `deploy/k8s/llm-gateway/` · **replicas ≥ 2** · label `app: aura-llm-gateway` |
| Provider catalog | ConfigMap `aura-llm-gateway-providers` · kinds `stub` `ollama` `openai` `vllm` `sglang` · lab chat `gemma4:e2b-mlx` · lab `embeddings`=`embeddinggemma-2:270m-mxfp8-text` @ `host.orb.internal:11434/v1` |
| Lab memory-embed | [`memory-embed-ollama-lab.md`](memory-embed-ollama-lab.md) (Function ConfigMap `aura-memory-embed-lab`) |
| PG / MQT | 없음 |

---

## 검증

```bash
bash deploy/scripts/check-llm-gateway.sh
node services/llm-gateway/gateway.selftest.js   # client egress
cargo test -p aura-llm-gateway                  # server parity
```

M3 성공 기준: **LLM 직접 호출 없음** — 클라이언트 가드 + NP allowlist peer.
