# Aura

**Agent + MCP Serverless Runtime** — NATS MSA + Fission. 태스크 MQT(+DLQ)·Fair Queue, sync Warm Pool, **`aura.stream.<run_id>`** + Gateway SSE, **LLM Gateway**, PG Pooler/HA, 샌드박스·mTLS. 메모리는 **`svc-memory`** + 파티션/TTL.

계약·인터페이스: [ARCHITECTURE.md](ARCHITECTURE.md).  
일정: [ROADMAP.md](ROADMAP.md).  
에이전트/기여 워크플로: [AGENTS.md](AGENTS.md).

## Quickstart

코드·클러스터 매니페스트는 **M0**부터 추가한다. 지금은 문서만 있다.

1. [ARCHITECTURE.md](ARCHITECTURE.md) §1 계약 확인
2. [ROADMAP.md](ROADMAP.md) M0 성공 기준으로 Fission + KEDA + NATS 부트스트랩

로컬 빌드/테스트 명령은 각 컴포넌트 `DESIGN.md`의 `## Commands`에 코드와 함께 생긴다.

## Out of scope (초기)

LLM serving, 사용자 Chat UI 풀스택, 헬프데스크 티켓/옴니채널, path-graph/VFS 통째 이식.
