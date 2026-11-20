# Multi-env — python-env 병행 · custom-env 후속 (M3.6+)

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

### 브리지 매핑

| subject | runtime | Function |
|---------|---------|----------|
| `aura.tasks.agent.invoke` | `nodejs` | `aura-agent-invoke` |
| `aura.tasks.agent.invoke` | `python` | `aura-agent-invoke-py` |
| `aura.tasks.mcp.invoke` | `nodejs` | `aura-mcp-invoke` |
| `aura.tasks.mcp.invoke` | `python` | `aura-mcp-invoke-py` |
| `aura.rpc.mcp.tool` | `nodejs` | `aura-mcp-invoke-rpc` |
| `aura.rpc.mcp.tool` | `python` | `aura-mcp-invoke-rpc-py` |

## 후속 — `custom-env`

| 항목 | 내용 |
|------|------|
| Environment | `aura-custom-async` / `aura-custom-sync` (이미지·빌더는 별 런북) |
| Function 슬롯 | `aura-agent-invoke-custom` · `aura-mcp-invoke-custom` · `aura-mcp-invoke-rpc-custom` |
| resolve | `runtime=custom` |
| 소스 | `services/*/custom/` |

## 이후 — `rust-env`

| 항목 | 내용 |
|------|------|
| 후보 | sync `aura.rpc.mcp.tool` 핫패스 PoC |
| 채택 조건 | p95/CPU 이득 실측 후 Warm RPC만 또는 별 Function |
| 금지 | 전면 재작성 · connector 교체 |

## Non-goals

Gateway / `svc-memory` / `svc-control` / LLM Gateway의 언어 전환 · 메시지 단독 언어 선택 · subject `.py` 분리.
