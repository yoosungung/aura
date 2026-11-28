# Gateway · inflight `release` + `agent_invoke` bypass re-check (M3 · §2.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #16 · §2.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
Fair Queue 본문: [`gateway-fair-queue.md`](gateway-fair-queue.md).  
우회 진입: [`agent-invoke-mqt.md`](agent-invoke-mqt.md) · [`../../services/agent-invoke/DESIGN.md`](../../services/agent-invoke/DESIGN.md).

**이 문서 범위:** terminal subject/frame → `release` · 멱등 감산 · **`ensureAdmitted` 우회 재확인**.  
**Non-goals:** live NATS done/error 구독 Deployment · F1 샤딩 · sandbox · live LLM.

---

## Terminal → inflight 감산

| 소스 | 트리거 | API |
|------|--------|-----|
| Core stream | `aura.stream.<run_id>` frame `run.completed` \| `error` | `openStreamBridge` → `rateLimiter.release` (첫 terminal만) |
| JetStream event | `aura.events.agent.invoke.done` \| `aura.events.agent.invoke.error` | `releaseInflightFromEvent(subject, tenant_id, run_id)` |

- `release`는 `runs[run_id]` 제거 + `inflight -= 1` — **멱등** (이중 호출·스트림+이벤트 동시 와도 1회만 감산).
- 생산 NATS 구독 배선은 후속; `cargo test -p aura-gateway`가 계약 정본.

---

## 우회 publish · `ensureAdmitted`

Gateway 없이 `aura.tasks.agent.invoke`에 task가 올 수 있다.

| 경로 | 동작 |
|------|------|
| Gateway 제출 | `tryAcquire`로 `runs[run_id]` 등록 후 publish |
| `agent_invoke` 진입 | injectable `rateLimiter.ensureAdmitted(tenant_id, run_id)` — **동일 KV** `quota.{tenant_id}` |
| 이미 등록된 `run_id` | `ensureAdmitted` **멱등 통과** (추가 토큰 소모 없음) |
| 우회·초과 | HTTP **429** · body `type: agent.invoke.error` · **poison** (턴/RPC 미실행 · 재큐 금지) |
| 미주입 (로컬) | noop stub; 생산은 Gateway와 공유 limiter 필수 |

구현: [`services/gateway/src/rate_limit.rs`](../../services/gateway/src/rate_limit.rs) · [`services/agent-invoke/handler.js`](../../services/agent-invoke/handler.js).

---

## 검증

```bash
bash deploy/scripts/check-gateway-inflight-release.sh
cargo test -p aura-gateway
node services/agent-invoke/handler.selftest.js
```