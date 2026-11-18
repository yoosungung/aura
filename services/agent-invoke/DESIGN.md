# agent_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #10 · #11 · #13 · §2 · §3.2 · §3.5 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — `agent_invoke` MQT + 스트림 프레임.  
와이어·프레임 정본: [`deploy/docs/agent-invoke-mqt.md`](../../deploy/docs/agent-invoke-mqt.md).  
주입 예산: [`deploy/docs/agent-inject-contract.md`](../../deploy/docs/agent-inject-contract.md).

**이 문서 범위:** Fission MQT 핸들러 경계 · RPC 의존(주입) · `aura.stream.<run_id>` publish · done envelope.  
**Non-goals (본 슬라이스):** Gateway SSE/WS·principal 인가 · Fair Queue/Token Bucket · live LLM Gateway HTTP · live NATS Core 클라이언트 배선 · `mcp_invoke` Function · `aura.rpc.control.resolve` 브리지 Deployment · `agent_checkpoints` DDL.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 턴 실행: resolve → recall → (stub) turn → 선택 mcp tool; 스트림 프레임; done/error |
| 실행 계급 | **async** MQT · `minReplicaCount=0` |
| PG | **금지** (Zero Direct Write). 체크포인트 예외 테이블은 후속 M3 항목 |
| LLM | 생산 = LLM Gateway만(§9.4). 본 슬라이스 = **주입 가능 `runTurn`**(기본=결정적 stub) |
| 스트림 | `publishStream(run_id, frame)` 주입 — 대상 subject `aura.stream.<run_id>` (Core, 유실 허용) |
| 금지 | `memory_*` 직접 쓰기 · plaintext `secrets` · JetStream에 토큰 적재 · invoke payload에 bundle/cfg |

---

## MQT (§3.2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.agent.invoke` |
| consumer | `aura_agent_invoke` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.agent.invoke.done` |
| errorTopic | `aura.events.agent.invoke.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/agent-invoke/`](../../deploy/k8s/agent-invoke/) |

성공 HTTP 200 본문 = done envelope → MQT `respTopic`. 스트림 프레임은 respTopic이 **아님**.

---

## RPC 의존 (요청자)

| Subject | 용도 | 본 슬라이스 |
|---------|------|------------|
| `aura.rpc.control.resolve` | 번들 메타·cfg·`secrets_ref` | injectable `resolve` (기본 stub) |
| `aura.rpc.memory.recall` | `items[]`만 주입 | injectable `recall` |
| `aura.rpc.mcp.tool` | 툴 호출 | injectable `mcpTool` (input.tool 있을 때) |

라이브 Core RR 구독·브리지는 별 티켓.

---

## Commands

```bash
bash deploy/scripts/check-agent-invoke.sh
node services/agent-invoke/handler.selftest.js
```
