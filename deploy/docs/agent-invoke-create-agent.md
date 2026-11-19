# `agent_invoke` · `createAgent` runTurn (M3.5)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #9–#13 · §3.5 · §9.4.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.5.  
내부: [`../../services/agent-invoke/DESIGN.md`](../../services/agent-invoke/DESIGN.md).  
MQT 프레임: [`agent-invoke-mqt.md`](agent-invoke-mqt.md).  
패키징: [`fission-node-archive.md`](fission-node-archive.md).  
체크포인트: [`agent-checkpoints.md`](agent-checkpoints.md).

**이 문서 범위:** `runTurn` = LangChain.js `createAgent` · LLM Gateway egress · 스트림 매핑 · checkpoints 훅.  
**Non-goals:** python-env · live provider CI 필수 · Gateway Fallback(M5).

---

## 경계

| 항목 | 규칙 |
|------|------|
| 셸 | `invokeOnce` 불변 (validate → admit → resolve → recall pack → `runTurn` → done) |
| 인지 루프 | `createAgent` in [`run-turn-create-agent.js`](../../services/agent-invoke/run-turn-create-agent.js) |
| LLM | **`assertFunctionLlmEgress` + `createLlmGatewayClient`만**. `ChatOpenAI.baseURL` 직행 금지 |
| 툴 | `ctx.mcpTool` → LangChain tool 래퍼 → `aura.rpc.mcp.tool` (또는 injectable) |
| 스트림 | agent stream events → `publishStream` (`token` / `tool.*`) |
| PG | `memory_*` 금지. **`agent_checkpoints`만** Pooler + `set_config(..., true)` |

---

## 모델 팩토리

```text
createGatewayChatModel({ baseUrl, tenantId, transport? })
  → assertFunctionLlmEgress(baseUrl)
  → createLlmGatewayClient({ baseUrl, transport })
  → LangChain-compatible chat model wrapping client.chatCompletions
```

우회(공급자 호스트·비-Gateway URL)는 TDD에서 **throw `provider_direct_forbidden`**.

---

## 검증

```bash
node services/agent-invoke/handler.selftest.js
node services/agent-invoke/run-turn-create-agent.selftest.js
bash deploy/scripts/check-agent-invoke.sh
bash deploy/scripts/check-agent-checkpoints.sh
```
