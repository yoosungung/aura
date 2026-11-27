# Aura

**Agent + MCP Serverless Runtime** — NATS MSA + Fission. 태스크 MQT(+DLQ)·Fair Queue, sync Warm Pool, **`aura.stream.<run_id>`** + Gateway SSE, **LLM Gateway**, PG Pooler/HA, 샌드박스·mTLS. 메모리는 **`svc-memory`** + 파티션/TTL.

계약·인터페이스: [ARCHITECTURE.md](ARCHITECTURE.md).  
메시지·호출 흐름(다이어그램): [MESSAGE-FLOW.md](MESSAGE-FLOW.md).  
일정: [ROADMAP.md](ROADMAP.md).  
에이전트/기여 워크플로: [AGENTS.md](AGENTS.md).

## Quickstart

1. [ARCHITECTURE.md](ARCHITECTURE.md) §1 계약 확인
2. 로컬 deps (루트 workspaces + 공유 `.venv`; `admin-ui`는 `cd services/admin-ui && npm install`)
   ```sh
   npm install
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   ```
3. [deploy/SETUP.md](deploy/SETUP.md) — NATS JetStream · KEDA · Fission · 스트림 · async/sync 분리 배포 골격
   ```sh
   bash deploy/scripts/install-runtime.sh
   bash deploy/scripts/smoke-runtime.sh
   bash deploy/scripts/smoke-streams.sh
   bash deploy/scripts/check-split-deploy.sh   # V0.1 static gate (no cluster)
   ```
4. [ROADMAP.md](ROADMAP.md) M0 나머지(샘플 Function 본문·V0.2/V0.3·DLQ 경로)

로컬 빌드/테스트 명령은 각 컴포넌트 `DESIGN.md`의 `## Commands`에 코드와 함께 생긴다.

## Out of scope (초기)

LLM serving, 사용자 Chat UI 풀스택, 헬프데스크 티켓/옴니채널, path-graph/VFS 통째 이식.
