# Gateway · agent invoke E2E smoke (lab)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #1 · #13 · §2 · §3.5 · §7.  
와이어: [`gateway-sse-ws.md`](gateway-sse-ws.md).  
내부: [`../../services/gateway/DESIGN.md`](../../services/gateway/DESIGN.md).  
일정: [ROADMAP.md](../../ROADMAP.md) M3 잔여.

**이 문서 범위:** lab live `POST /v1/agent/invoke` → `202`+`run_id` → SSE 경로 인가 → principal mismatch **403**.  
**Non-goals:** admin-ui Chat · 대화형 REPL CLI · OIDC · port-forward · live NATS SSE frame pump(canary 후속) · Fair Queue 노이지 실측.

---

## 전제

| 항목 | 값 |
|------|-----|
| 클러스터 | orbstack lab · ns `aura` |
| Gateway | `deploy/aura-gateway` Ready · Service `aura-gateway` |
| Base URL | **`http://aura-gateway.aura.svc.cluster.local:8080`** (in-cluster DNS only · **port-forward 금지**) |
| Probe | curl 가능 ephemeral Pod → Gateway Service |
| Headers | `X-Aura-Tenant-Id` · `X-Aura-Principal-Id` |
| Publish | lab Gateway는 NATS publish **no-op sink** 가능 — invoke **202**·레지스트리 인가만 게이트 |

---

## 성공 기준

| # | 단계 | 기대 |
|---|------|------|
| 1 | `POST /v1/agent/invoke` | **202** · body `run_id` = **UUIDv7** · `stream_subject`=`aura.stream.<run_id>` |
| 2 | `GET /v1/runs/:run_id/events` (동일 principal) | **200** · authorize ok (`content_type`=`text/event-stream` 또는 동등 계약 필드) |
| 3 | 동일 경로 · **다른** principal | **403** · `principal_forbidden` |
| 4 | 미등록 `run_id` | **404** · `run_not_found` |

### Live SSE frame pump (soft-skip)

현재 Gateway HTTP는 **authorize-only** (`stream_pump_deferred_to_canary`).  
`token` / `run.completed` 프레임 수신은 **후속** — smoke는 프레임 부재를 **PASS 조건으로 요구하지 않는다**(문서·로그에 `SOFT_SKIP_SSE_PUMP` 표기).

---

## 검증

```bash
# 정적(문서·스크립트·체크 게이트) — 클러스터 불필요
SMOKE_GATEWAY_AGENT_INVOKE_STATIC=1 bash deploy/scripts/smoke-gateway-agent-invoke.sh

# lab live (in-cluster DNS)
bash deploy/scripts/smoke-gateway-agent-invoke.sh

bash deploy/scripts/check-gateway-sse-ws.sh
```
