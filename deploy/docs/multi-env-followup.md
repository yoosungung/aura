# Multi-env follow-up — python-env · rust-env (post M3.5)

일정: [ROADMAP.md](../../ROADMAP.md) M3.6+.  
전제: M3.5 Node `createAgent` + archive 완료. MQT connector는 언어 무관.

## M3.6 — `python-env`

| 항목 | 내용 |
|------|------|
| 대상 | `agent_invoke` · `mcp_invoke` Function을 `ghcr.io/fission/python-env`로 이식 |
| 패리티 | 동일 NATS subject · done envelope · `tools/list` · Gateway egress |
| 인지 루프 | Python `langchain.agents.create_agent` |
| 검증 | Node vs Python 동일 픽스처 selftest / smoke |

## 이후 — `rust-env`

| 항목 | 내용 |
|------|------|
| 후보 | sync `aura.rpc.mcp.tool` 핫패스 PoC |
| 채택 조건 | p95/CPU 이득 실측 후 Warm RPC만 또는 별 Function |
| 금지 | 전면 재작성 · MQT connector 교체 |

## Non-goals

Gateway / `svc-memory` / `svc-control` / LLM Gateway의 언어 전환은 본 문서 범위 밖.
