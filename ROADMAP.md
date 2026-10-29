# ROADMAP.md

수행 순서와 성공 기준만 적는다. 계약·스키마·이벤트는 [ARCHITECTURE.md](ARCHITECTURE.md). 기획 원본은 [docs/설계서.md](docs/설계서.md), [docs/헬프데스크 솔루션 구현 분석.md](docs/헬프데스크%20솔루션%20구현%20분석.md), [docs/아키텍처_개선.md](docs/아키텍처_개선.md).

스택: Go 코어 + Python `svc-ai-agent`, 프론트 React + Vite. 개발은 TDD (스켈레톤 → 테스트 → 구현). 빈 컴포넌트 stub·빈 `deploy/`·빈 CI 워크플로는 만들지 않는다. 코드가 처음 들어가는 폴더에만 `DESIGN.md`와 `## Commands`를 추가한다.

출시 선은 **P7**. 한 테넌트가 웹·이메일·카카오로 상담하고, SLA/CSAT/리포트/웹훅이 돌며, AI Ego-Graph 초안·승인 카드가 동작하는 상태다.

## P0 문서 — 완료 조건

- [ARCHITECTURE.md](ARCHITECTURE.md) §1 계약과 §2 이후 형태가 있다.
- 이 파일에 P0~P7과 미결정이 있다.
- [README.md](README.md)는 소개와 문서 링크만 한다.

성공: 제품 범위가 코드가 아닌 문서에만 있다.

## P1 백본

목표: 이벤트 한 건이 PG에 멱등으로 적재된다.

- `deploy/compose/`: PostgreSQL 16+pgvector, NATS JetStream. MinIO는 P3.
- `backend/`: Go module, `cmd/ingestion-worker`, [ARCHITECTURE.md](ARCHITECTURE.md) §10 DDL 마이그레이션, RLS FORCE (`(SELECT current_setting(...))` InitPlan).
- `contracts/`: `message_created` JSON Schema. Envelope에 `schema_version`, `trace_id`, `causation_id`, `hop_count`. ID는 UUIDv7.
- 배치: 500건 또는 100ms. 엔티티 계층 정렬 Upsert. `ON CONFLICT (id) DO NOTHING`. 실패 시 단건 폴백, 영구 실패는 `helpdesk.dlq.ingestion` ACK.
- 부모 행(`contacts`/`conversations`)은 테스트 픽스처로 넣는다. 생성 RPC는 P2.

성공: 같은 `message_created`를 두 번 publish해도 `messages` 행은 하나. 독성 1건은 DLQ로 가고 나머지 배치는 커밋된다. TDD: 마이그레이션 → JetStream 컨슈머 → 배치 플러시 → DLQ. **완료.**

## P2 라이브챗 알파

목표: 내부 사용자가 위젯으로 상담원과 왕복한다.

- `gateway-web`: 위젯 WS, 상담원 WS, Contact/User 토큰 구독 격리, Client API 메시지 생성(이벤트 발행). 신규 대화는 `svc-core` 생성 RPC 성공 후에만 `message_created`.
- `svc-core`: FSM `unassigned`/`open`/`pending`/`resolved`, 컨택트·대화 PG 동기 커밋(Outbox), `version` CAS, Request-Reply.
- `frontend`: 큐 + 스레드(3-Pane 중 좌·중).
- `packages/widget-sdk`: iframe + origin 화이트리스트 `postMessage`.

성공: 외부 페이지 위젯 메시지 → core 생성 → NATS → PG → 상담원 화면, 답장이 위젯에 보인다. 동시에 두 전이를 보내면 하나만 커밋된다. snooze·카카오·이메일은 아직 없다.

## P3 헬프데스크 MVP

목표: 한 팀이 웹 채널만으로 실제 상담을 끝낸다.

- 로그인과 RBAC (`administrator`/`agent`). Auth 방식은 아래 미결정을 P3 착수 전에 고른다.
- `inbox_members`, 수동 배정, 내부 메모, snooze, 라벨, 매크로·저장응답.
- 첨부: MinIO + `attachments`.
- Application API (대화·메시지·컨택트).
- `setUser` HMAC.
- WebSocket은 짧은 만료 서명 토큰. `pubsub_token`은 시드로만 유지한다.

성공: 관리자가 상담원을 인박스에 넣고, 상담원이 메모·라벨·첨부로 티켓을 resolved 한다.

## P4 옴니채널

- `gateway-email`: In-Reply-To / References → `source_id`, 구분자 `##- Please type your reply above this line -##`, 제목 `[#REQ-{display_id}]`.
- `gateway-kakao`: 상담톡 30일 세션, 세션 밖 알림톡 템플릿.
- `helpdesk.tasks.outbound.email` / `outbound.kakao`.
- 256KB 초과 본문·MIME은 오브젝트 스토리지 Claim-Check (`content_ref`).
- 고객 병합: `contact_merged` 이벤트, `contacts.merged_into_contact_id`.

성공: 메일 회신이 기존 티켓에 붙는다. 카카오 세션이 없으면 알림톡으로 나간다. `gateway-social`은 출시 후.

## P5 운영 자동화

- `svc-sla-routing`: 온라인 + `C_current < C_max` 라운드로빈, 영업시간, 부재중 greeting. `C_current`는 NATS JetStream KV 원자 증감, PG는 대사.
- `svc-automation`: Event → Conditions → Actions (팀/우선순위/라벨/웹훅 트리거). `hop_count > 5`면 드롭.
- SLA FRT/NRT/RT, `applied_slas`, breach 시 큐 플래그.
- resolved 시 CSAT (`content_type=input_csat`).

성공: 미배정 티켓이 자동 할당되고, FRT breach가 큐에 보인다. Pending은 NRT를 멈춘다. 동시에 들어온 티켓이 한 상담원 용량을 넘기지 않는다.

## P6 플랫폼

- Client API 정식화, Platform API (테넌트 프로비저닝).
- HMAC 아웃바운드 웹훅 + 재시도 큐 (`helpdesk.tasks.webhooks.deliver`).
- 리포트: 대화 / 상담원 / 인박스 / CSAT%(4–5점 비율) / SLA hit rate.
- Help Center `articles` + 위젯 검색.

성공: 외부 CRM이 `message_created` 웹훅을 검증해 받고, 관리자가 CSAT%와 SLA hit rate를 본다.

## P7 AI-Native 출시

- `svc-ai-agent`: Ego-Graph 1~2홉 읽기, ReAct/Tool, 저위험 자동 아웃바운드, 고위험 승인 카드, resolved 시 ontology extract.
- 3-Pane 우측 Living Profile.
- 채널별 rate limit·서킷브레이커.
- 임베딩을 본 테이블에서 분리(`model`/`version` 메타, HNSW). `ontology_edges` 시간 유효성(`valid_from`/`valid_until`).
- JetStream → 오브젝트 스토리지 Cold Event 아카이브. 고객 파기 시 subject purge API.
- `deploy/k8s/base/`, `deploy/SETUP.md`, `.github/workflows/ci.yml` — 이 시점에 실제 배포·PR이 생길 때 추가.

성공: 웹+메일+카카오로 **파일럿 테넌트 1곳**이 돌아간다. 이 마일스톤이 제품 출시 선.

## 출시 후

- `gateway-social` (WhatsApp 24시간 창, SMS)
- Skill/Team 라우팅 고도화
- PG 읽기 복제본
- 멀티리전 첨부 버킷
- `messages` 등 대용량 테이블 UUIDv7 범위 파티셔닝(PK는 `id` 유지)
- Task Fair Queuing(테넌트 쿼터)

## 미결정 (P3 착수 전에 고친다)

| 항목 | 선택지 | 기본 가정 |
|---|---|---|
| Auth | 자체 세션 vs OIDC | P2는 개발용 토큰. P3에서 결정 |
| LLM 벤더 | OpenAI 호환 / 기타 | P7 착수 전. P1–P6는 `vector(1536)`. 모델 교체는 P7 embeddings 분리로 검토 |
| NATS 격리 | account 대 subject prefix `helpdesk.events.<account_id>.>` | P1–P6는 subject prefix. account 격리는 P7 운영 검토 |
| 첨부 버킷 | 테넌트 prefix vs 버킷 분리 | P3는 MinIO 단일 버킷 + `account_id/` prefix |

Auth와 무관하게 `users.pubsub_token` / `contact_inboxes.pubsub_token` 컬럼은 유지한다. P3부터 WS 인증은 짧은 만료 서명 토큰이다.
