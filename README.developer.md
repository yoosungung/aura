# Aura — 개발자

기여자 온보딩이다. 설치·클러스터 배포는 [README.md](README.md), 런북은 [deploy/SETUP.md](deploy/SETUP.md).

옴니채널 헬프데스크와 고객 Ego-Graph AI 에이전트를 한 PostgreSQL·NATS 백본 위에 둔 CRM이다. 계약은 [ARCHITECTURE.md](ARCHITECTURE.md), 마일스톤은 [ROADMAP.md](ROADMAP.md), 에이전트·문서 레이아웃은 [AGENTS.md](AGENTS.md). 기획 원본은 [docs/설계서.md](docs/설계서.md), [docs/헬프데스크 솔루션 구현 분석.md](docs/헬프데스크%20솔루션%20구현%20분석.md).

스택은 Go 코어, Python `svc-ai-agent`, React 상담원 SPA, `packages/widget-sdk` 호스트 로더다. 컴포넌트 내부 명령은 각 `DESIGN.md` `## Commands`.

## 로컬 개발

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend && go test ./...
go run ./cmd/ingestion-worker
go run ./cmd/svc-core
```

나머지 프로세스·환경변수는 [backend/DESIGN.md](backend/DESIGN.md), [frontend/DESIGN.md](frontend/DESIGN.md), [packages/widget-sdk/DESIGN.md](packages/widget-sdk/DESIGN.md), [svc-ai-agent/DESIGN.md](svc-ai-agent/DESIGN.md) `## Commands`. 프론트 로컬은 Vite가 `/auth`·`/api`·`/ws`를 `gateway-web(:8080)`으로 프록시한다.

## 기여

TDD(스켈레톤 → 테스트 → 구현). 계획 변경은 `ROADMAP.md`, 계약은 `ARCHITECTURE.md`, 컴포넌트 내부는 `<comp>/DESIGN.md`, 워크플로는 `AGENTS.md`. 한 문서에 같은 내용을 중복하지 않는다. PR/push CI는 `.github/workflows/ci.yml`.
