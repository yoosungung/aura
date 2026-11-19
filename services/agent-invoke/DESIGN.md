# agent_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #10 · #11 · #13 · §2 · §3.2 · §3.5 · §6.1.2 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) **M3.5** — Node `createAgent` · archive · checkpoints writer.  
와이어: [`deploy/docs/agent-invoke-mqt.md`](../../deploy/docs/agent-invoke-mqt.md) · [`deploy/docs/agent-invoke-create-agent.md`](../../deploy/docs/agent-invoke-create-agent.md).  
주입 예산: [`deploy/docs/agent-inject-contract.md`](../../deploy/docs/agent-inject-contract.md).  
체크포인트: [`deploy/docs/agent-checkpoints.md`](../../deploy/docs/agent-checkpoints.md).  
패키징: [`deploy/docs/fission-node-archive.md`](../../deploy/docs/fission-node-archive.md).  
MCP: [`../mcp-invoke/DESIGN.md`](../mcp-invoke/DESIGN.md) · [`deploy/docs/mcp-tools-list.md`](../../deploy/docs/mcp-tools-list.md).

**이 문서 범위:** Fission MQT 핸들러 · `runTurn`=`createAgent` · RPC 주입 · 스트림 · done · 쿼터 재확인 · checkpoints Pooler writer.  
**Non-goals:** python/rust env(M3.6+) · Gateway Token Bucket 본구현 · live provider CI 필수.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 턴 실행: resolve → recall → **`createAgent` turn** → mcp tool; 스트림; done/error; checkpoints |
| topic | `aura.tasks.agent.invoke` → `aura.events.agent.invoke.done` / `aura.events.agent.invoke.error` |
| 스트림 | `aura.stream.<run_id>` |
| 실행 계급 | **async** MQT · `minReplicaCount=0` |
| 패키징 | **archive** + `node-builder` (literal 폐기) |
| PG | `memory_*` **금지**. 예외=`agent_checkpoints`만 Pooler + `set_config(..., true)` |
| LLM | `assertFunctionLlmEgress` + LLM Gateway client only (§9.4) |
| 금지 | plaintext `secrets` · JetStream 토큰 · invoke에 bundle/cfg · 공급자 직접 URL · `memory_*` PG |

---

## 모듈

| 파일 | 역할 |
|------|------|
| `handler.js` | `invokeOnce` 셸 · Fission entry |
| `run-turn-create-agent.js` | LangChain `createAgent` + 스트림 매핑 |
| `llm-gateway-model.js` | egress 강제 + Gateway chat 어댑터 |
| `checkpoints.js` | Pooler writer/resume (`agent_checkpoints`) |
| `nats-deps.js` | live Core RR / publishStream (Phase B) |

---

## Commands

```bash
bash deploy/scripts/check-agent-invoke.sh
bash deploy/scripts/check-agent-checkpoints.sh
bash deploy/scripts/build-agent-invoke-archive.sh
node services/agent-invoke/handler.selftest.js
node services/agent-invoke/run-turn-create-agent.selftest.js
node services/agent-invoke/checkpoints.selftest.js
```
