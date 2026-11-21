# Multi-env — python-env 병행 · custom image (M3.6+)

일정: [ROADMAP.md](../../ROADMAP.md) M3.6.  
계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #11 · §4.  
archive: [`fission-node-archive.md`](fission-node-archive.md) · [`fission-python-archive.md`](fission-python-archive.md).  
브리지: [`nats-task-bridge.md`](nats-task-bridge.md).

전제: M3.5 Node `createAgent` + archive 완료. **Node agent/MCP 제품 경로 유지** — 교체 아님.

## M3.6 — `python-env` 병행

| 항목 | 내용 |
|------|------|
| 대상 | `agent_invoke` · `mcp_invoke`(async+RPC)에 Python Function **추가** |
| Subject | **동일** — `aura.tasks.agent.invoke` · `aura.tasks.mcp.invoke` · `aura.rpc.mcp.tool` |
| 권위 | `source_meta.runtime` (`nodejs`\|`python`\|`custom`, 기본 `nodejs`) — `svc-control`만 쓰기 |
| 메시지 | Gateway가 resolve `runtime` **스탬프** · Function은 resolve 재검증 |
| 라우팅 | task-bridge / rpc-bridge: `runtime` → Function 이름 |
| Environment | `aura-python-async` (poolsize 1) · `aura-python-sync` (poolsize ≥ 2) |
| 소스 | `services/agent-invoke/{nodejs,python}` · `services/mcp-invoke/{nodejs,python}` |
| 인지 루프 | Python `langchain.agents.create_agent` |
| 검증 | `check-python-env-parity.sh` · Node 회귀 + Python 동일 픽스처 |

## M3.6 후속 — `fastapi-env` 전환

| 항목 | 내용 |
|------|------|
| 대상 | `aura-python-async` / `aura-python-sync` 이미지만 교체 (이름·브리지 매핑 불변) |
| Runtime | `ghcr.io/fission/python-fastapi-env:1.35.0` |
| Builder | `ghcr.io/fission/python-fastapi-builder:1.35.0` |
| 엔트리 | Flask `main()` → FastAPI `async def main(request: Request)` (`handler.main`) |
| concurrency | `aura-agent-invoke-py` · `aura-mcp-invoke-py` = `4` · `aura-mcp-invoke-rpc-py` = 기본 1 |
| 패키징 | archive 유지 — env에 agent/MCP package bake 금지 |
| 검증 | `check-python-env-parity.sh` · Router 경유 python runtime 스모크 |
| 롤백 | Environment 이미지를 `python-env`로 되돌리고 handler 엔트리 git revert |

### 브리지 매핑

| subject | runtime | Function |
|---------|---------|----------|
| `aura.tasks.agent.invoke` | `nodejs` | `aura-agent-invoke` |
| `aura.tasks.agent.invoke` | `python` | `aura-agent-invoke-py` |
| `aura.tasks.mcp.invoke` | `nodejs` | `aura-mcp-invoke` |
| `aura.tasks.mcp.invoke` | `python` | `aura-mcp-invoke-py` |
| `aura.rpc.mcp.tool` | `nodejs` | `aura-mcp-invoke-rpc` |
| `aura.rpc.mcp.tool` | `python` | `aura-mcp-invoke-rpc-py` |
| `aura.tasks.agent.invoke` | `custom` | payload `function` 접두사 `aura-agent-invoke-` |
| `aura.tasks.mcp.invoke` | `custom` | payload `function` 접두사 `aura-mcp-invoke-` (`aura-mcp-invoke-rpc-` 제외) |
| `aura.rpc.mcp.tool` | `custom` | payload `function` 접두사 `aura-mcp-invoke-rpc-` |

## `custom` image

Fission container executor. Package·Environment·`/specialize` 없음. Router 이름만 Function CR이고 프로세스는 이미지다. NATS 구독은 task-bridge / rpc-bridge만 — 트리거는 topic 1개당 Function 1개이고 Core Request-Reply 트리거가 없다.

| 항목 | 내용 |
|------|------|
| 실행 | `runtime=custom` · `POST {FISSION_ROUTER_URL}/fission-function/<function>` |
| 스탬프 | Gateway가 resolve의 Function 이름을 payload `function`에 넣는다. 브리지는 위 접두사만 허용하고 poolmgr 슬롯(`aura-agent-invoke-py` 등)은 거부한다 |
| 스케일 | async container `MinScale=0` · sync container `MinScale≥2` |
| 재검증 | 이미지는 resolve로 `function`이 자기 소스인지 확인한다 |
| 금지 | 이미지별 MQT · 이미지의 NATS 직접 구독 · 공유 `aura-custom-*` Environment |

## 이후 — `rust-env`

| 항목 | 내용 |
|------|------|
| 후보 | sync `aura.rpc.mcp.tool` 핫패스 PoC |
| 채택 조건 | p95/CPU 이득 실측 후 Warm RPC만 또는 별 Function |
| 금지 | 전면 재작성 · connector 교체 |

## Non-goals

Gateway / `svc-memory` / `svc-control` / LLM Gateway의 언어 전환 · 메시지 단독 언어 선택 · subject `.py` 분리.
