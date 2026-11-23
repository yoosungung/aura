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
| 역할 | 턴 실행: resolve → recall → **`createAgent` turn**(cfg별) → mcp allowlist; 스트림; done/error; checkpoints |
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
| `testdata/` | 공유 JSON 픽스처 (`invoke_identifiers_only` · `agent_specs`) |

---

## 에이전트 스펙 (`cfg`)

resolve `cfg` 최상위. `runtime` 키는 금지. user overlay는 기존 1-depth merge(user wins)라 아래 키는 섹션 전체가 교체된다.

| 키 | 형태 | 규칙 |
|----|------|------|
| `system_prompt` | string | 없으면 `You are an Aura agent.` |
| `model` | string | 없으면 `aura-default`. LLM은 Gateway client만 |
| `tools` | `{ server, version, name }[]` | 이 목록만 MCP 바인딩. 키 없음=레거시 범용 `mcp_tool`(input.tool). `[]`=툴 없음 |
| `sub_agents` | `{ name, version, description }[]` | 같은 테넌트 `kind=agent` active 행 참조. 프롬프트·툴 인라인 금지 |

플랫폼 표식 entrypoint(`aura:createAgent`)는 이 cfg만 적용하고 GetObject를 호출하지 않는다. `module.path:attr`이면서 `sig_uri`가 있으면 같은 object-store LRU로 읽고 `factory(cfg, secrets_ref)`가 `{ runTurn }`를 반환한다. 절차는 [`services/object-store/DESIGN.md`](../object-store/DESIGN.md). `runtime=custom` 이미지는 #11·격리 문서다.

서브에이전트는 부모 턴의 툴이다. 같은 `run_id`·admission·Function. 깊이 상한 2(루트 1 + 자식 1). 깊이 2에서는 자식 `sub_agents`를 붙이지 않고, 깊이 3 진입은 `agent_depth_exceeded`. 스택에 같은 `name@version`이 있으면 `agent_cycle`.

스트림 `token` / `tool.started` / `tool.finished`에 `agent`(그 프레임을 낸 에이전트 이름)를 싣는다. 체크포인트 `state.agent`는 루트 태스크 이름이다.

payload의 `cfg` / `config` / `system_prompt` / `tools` / `sub_agents` / `bundle`은 `identifiers_only`로 거부한다.

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
