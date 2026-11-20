# agent_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #10 · #11 · #13 · §2 · §3.2 · §3.5 · §4.1 · §6.1.2 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) **M3.5–M3.6** — Node `createAgent` · python 병행 · task-bridge.  
와이어: [`deploy/docs/agent-invoke-mqt.md`](../../deploy/docs/agent-invoke-mqt.md) · [`deploy/docs/agent-invoke-create-agent.md`](../../deploy/docs/agent-invoke-create-agent.md) · [`deploy/docs/multi-env-followup.md`](../../deploy/docs/multi-env-followup.md).  
패키징: [`deploy/docs/fission-node-archive.md`](../../deploy/docs/fission-node-archive.md) · [`deploy/docs/fission-python-archive.md`](../../deploy/docs/fission-python-archive.md).  
MCP: [`../mcp-invoke/DESIGN.md`](../mcp-invoke/DESIGN.md).

**이 문서 범위:** 핸들러 · `nodejs/`/`python/` · resolve `runtime` 재검증 · task-bridge 라우팅 · checkpoints.  
**Non-goals:** custom-env 구현 · rust-env · Gateway Token Bucket 본구현 · live provider CI 필수.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 턴 실행: resolve → recall → **`createAgent` turn** → mcp tool; 스트림; done/error; checkpoints |
| topic | `aura.tasks.agent.invoke` → `aura.events.agent.invoke.done` / `aura.events.agent.invoke.error` (**task-bridge**, MQT 폐기) |
| 스트림 | `aura.stream.<run_id>` |
| 실행 계급 | **async** · scale-to-zero via task-bridge/KEDA |
| runtime | `source_meta.runtime` 권위 · 메시지 스탬프 · Function 재검증 |
| Functions | `aura-agent-invoke` (nodejs) · `aura-agent-invoke-py` (python) |
| 패키징 | archive · `nodejs/` + `python/` |
| PG | `memory_*` **금지**. 예외=`agent_checkpoints`만 Pooler + `set_config(..., true)` |
| LLM | `assertFunctionLlmEgress` + LLM Gateway client only (§9.4) |

---

## 레이아웃

| 경로 | 역할 |
|------|------|
| `DESIGN.md` | 공통 계약 |
| `nodejs/` | LangChain.js `createAgent` · selftest |
| `python/` | 패리티 handler · pytest |
| `testdata/` | 공유 JSON 픽스처 |

---

## Commands

```bash
bash deploy/scripts/check-agent-invoke.sh
bash deploy/scripts/check-python-env-parity.sh
bash deploy/scripts/build-agent-invoke-archive.sh
bash deploy/scripts/build-agent-invoke-python-archive.sh
node services/agent-invoke/nodejs/handler.selftest.js
node services/agent-invoke/nodejs/run-turn-create-agent.selftest.js
node services/agent-invoke/nodejs/checkpoints.selftest.js
```
