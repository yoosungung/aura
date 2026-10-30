# Aura

옴니채널 헬프데스크와 고객 Ego-Graph AI 에이전트를 한 PostgreSQL·NATS 백본 위에 둔 CRM이다. 상담원은 Rail + 3-Pane 워크스페이스에서 웹·이메일·카카오 티켓을 처리하고, AI는 저위험 응답을 자동으로 보내거나 고위험 액션을 승인 카드로 넘긴다.

기획 원본은 [docs/설계서.md](docs/설계서.md), [docs/헬프데스크 솔루션 구현 분석.md](docs/헬프데스크%20솔루션%20구현%20분석.md). 지켜야 할 계약은 [ARCHITECTURE.md](ARCHITECTURE.md), 마일스톤은 [ROADMAP.md](ROADMAP.md), 에이전트 워크플로는 [AGENTS.md](AGENTS.md).

## 로컬 실행

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend && go test ./...
go run ./cmd/ingestion-worker
go run ./cmd/svc-core
```

명령의 정본은 [backend/DESIGN.md](backend/DESIGN.md), [frontend/DESIGN.md](frontend/DESIGN.md), [packages/widget-sdk/DESIGN.md](packages/widget-sdk/DESIGN.md), [svc-ai-agent/DESIGN.md](svc-ai-agent/DESIGN.md) `## Commands`. 스택은 Go 코어, Python `svc-ai-agent`, React 상담원 SPA다. 배포는 [deploy/SETUP.md](deploy/SETUP.md).
