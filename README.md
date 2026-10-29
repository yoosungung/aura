# Aura

옴니채널 헬프데스크와 고객 Ego-Graph AI 에이전트를 한 PostgreSQL·NATS 백본 위에 둔 CRM이다. 상담원은 3-Pane 워크스페이스에서 웹·이메일·카카오 티켓을 처리하고, AI는 저위험 응답을 자동으로 보내거나 고위험 액션을 승인 카드로 넘긴다.

기획 원본은 [docs/설계서.md](docs/설계서.md), [docs/헬프데스크 솔루션 구현 분석.md](docs/헬프데스크%20솔루션%20구현%20분석.md). 지켜야 할 계약은 [ARCHITECTURE.md](ARCHITECTURE.md), 마일스톤은 [ROADMAP.md](ROADMAP.md), 에이전트 워크플로는 [AGENTS.md](AGENTS.md).

## 로컬 실행

P0(문서)까지 완료했다. compose·마이그레이션·워커 명령은 P1에서 `deploy/compose/`와 `backend/DESIGN.md`의 `## Commands`에 생긴다. 그 전까지 실행할 바이너리는 없다.

스택은 Go 코어, Python `svc-ai-agent`, React 상담원 SPA다.
