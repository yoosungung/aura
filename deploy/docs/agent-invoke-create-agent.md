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
| 툴 | `cfg.tools` allowlist → MCP 래퍼. 키 없음=범용 `mcp_tool`. `sub_agents`는 같은 Function의 자식 `createAgent` |
| 스트림 | `token` / `tool.*` 에 `agent` 이름 |
| 깊이 | 서브에이전트 2(루트+1). 초과=`agent_depth_exceeded`. 사이클=`agent_cycle` |
| PG | `memory_*` 금지. **`agent_checkpoints`만** Pooler + `set_config(..., true)`. `state.agent`=루트 이름 |

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

## cfg로 여러 에이전트

공유 Function 하나. 조회는 `tenant_id` + `kind=agent` + `name` + `version`. `cfg` 형태는 [`services/agent-invoke/DESIGN.md`](../../services/agent-invoke/DESIGN.md) 에이전트 스펙. `createAgent`에 넘기는 데이터는 `systemPrompt`, `model`, allowlist로 만든 `tools`다. `sub_agents`는 LangChain 인자가 아니라, 자식 resolve 뒤 같은 `createAgent`를 다시 호출하는 툴이다. `aura:createAgent`는 GetObject 없이 cfg만 쓴다. `module.path:attr`+`sig_uri`는 [`services/object-store/DESIGN.md`](../../services/object-store/DESIGN.md) LRU→`GetObject` 뒤 `factory(cfg, secrets_ref).runTurn`이다.

---

## 검증

```bash
node services/agent-invoke/handler.selftest.js
node services/agent-invoke/run-turn-create-agent.selftest.js
bash deploy/scripts/check-agent-invoke.sh
bash deploy/scripts/check-agent-checkpoints.sh
```
