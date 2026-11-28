# LLM Gateway 콘텐츠 라우터 (M5.1 · §9.4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.4.  
Fallback/과금: [`llm-gateway-fallback-billing.md`](llm-gateway-fallback-billing.md).  
내부: [`../../services/llm-gateway/DESIGN.md`](../../services/llm-gateway/DESIGN.md).

**이 문서 범위:** `model: "aura-auto"` opt-in 휴리스틱 티어 라우팅 · ConfigMap `routing.tiers` · `X-Aura-Route-Pin` · 응답 `aura.route` · usage `route_tier`.  
**Non-goals:** 학습형 분류기(RouteLLM 등) · 품질 cascade(small→gate→large) · 전 트래픽 강제 라우팅 · embeddings 라우팅 · streaming · PG ledger.

---

## 라우팅 vs Fallback

| 축 | 트리거 | 목적 |
|----|--------|------|
| **콘텐츠 라우팅** | `body.model === "aura-auto"` | 요청 난이도 → `simple\|medium\|complex` → 모델 id |
| **가용성 Fallback** | provider 실패/circuit | `providers[]` 순서 + `fallbackModels` |

라우팅이 고른 model id로 Fallback 체인을 탄다. 두 축을 섞지 않는다.

---

## 동작

1. 구체 model id 요청 → 라우팅 생략(핀). `aura.route` 없음.
2. `aura-auto` → 프로세스 내 휴리스틱이 `messages`를 점수화 → 티어.
3. 선택 헤더 `X-Aura-Route-Pin: simple|medium|complex`가 있으면 **하향 금지**(pin과 분류 중 높은 티어).
4. ConfigMap `routing.tiers[tier]` → `model_selected`. 비어 있으면 상위 티어 → 하위 티어 순으로 채움.
5. 성공 응답: `aura.route = { tier, reason, model_selected, pin }` + 기존 `model_served`/`fallback_used`.
6. usage 로그에 `route_tier` 기록.

---

## ConfigMap

`aura-llm-gateway-providers` → `providers.json` 선택 키 `routing`:

```json
{
  "routing": {
    "tiers": {
      "simple": "gemma4:e2b-mlx",
      "medium": "gemma4:e2b-mlx",
      "complex": "gemma4:e2b-mlx"
    }
  }
}
```

lab은 동일 ollama model이라도 티어 메타는 기록한다.

---

## 검증

```bash
bash deploy/scripts/check-llm-gateway-router.sh
cargo test -p aura-llm-gateway
cargo test -p aura-llm-gateway
```
