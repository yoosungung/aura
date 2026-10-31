# ROADMAP.md

수행 순서와 성공 기준만 적는다. 계약·스키마·이벤트는 [ARCHITECTURE.md](ARCHITECTURE.md). 기획 원본은 [docs/설계서.md](docs/설계서.md), [docs/헬프데스크 솔루션 구현 분석.md](docs/헬프데스크%20솔루션%20구현%20분석.md), [docs/아키텍처_개선.md](docs/아키텍처_개선.md), [docs/UI_UX_레이아웃_설계안.md](docs/UI_UX_레이아웃_설계안.md), [docs/프론트엔드_위젯_검토.md](docs/프론트엔드_위젯_검토.md).

스택: Go 코어 + Python `svc-ai-agent`, 프론트 React + Vite. 개발은 TDD (스켈레톤 → 테스트 → 구현). 빈 컴포넌트 stub·빈 `deploy/`·빈 CI 워크플로는 만들지 않는다. 코드가 처음 들어가는 폴더에만 `DESIGN.md`와 `## Commands`를 추가한다.

출시 선은 **P7**. 한 테넌트가 웹·이메일·카카오로 상담하고, SLA/CSAT/리포트/웹훅이 돌며, AI Ego-Graph 초안·승인 카드가 동작하는 상태다. **P5 다음·P6 전에 P5.5 상담 워크스페이스**로 셸을 고정한다. P7 Living Profile·승인 카드는 그 레이아웃을 바꾸지 않고 칸만 채운다. 시각 명세는 [docs/UI_UX_레이아웃_설계안.md](docs/UI_UX_레이아웃_설계안.md), 현황 결함은 [docs/프론트엔드_위젯_검토.md](docs/프론트엔드_위젯_검토.md).

## P0 문서 — 완료 조건

- [ARCHITECTURE.md](ARCHITECTURE.md) §1 계약과 §2 이후 형태가 있다.
- 이 파일에 P0~P7·P5.5와 미결정·결정 로그가 있다.
- [README.md](README.md)는 운영자·배포자, [README.developer.md](README.developer.md)는 기여자. 계약은 링크만 한다.

성공: 제품 범위가 코드가 아닌 문서에만 있다.

## P1 백본

목표: 이벤트 한 건이 PG에 멱등으로 적재된다.

- `deploy/compose/`: PostgreSQL 16+pgvector, NATS JetStream. SeaweedFS는 P3.
- `backend/`: Go module, `cmd/ingestion-worker`, [ARCHITECTURE.md](ARCHITECTURE.md) §10 DDL 마이그레이션, RLS FORCE (`(SELECT current_setting(...))` InitPlan).
- `contracts/`: `message_created` JSON Schema. Envelope에 `schema_version`, `trace_id`, `causation_id`, `hop_count`. ID는 UUIDv7.
- 배치: 500건 또는 100ms. 엔티티 계층 정렬 Upsert. `ON CONFLICT (id) DO NOTHING`. 실패 시 단건 폴백, 영구 실패는 `helpdesk.dlq.ingestion` ACK.
- 부모 행(`contacts`/`conversations`)은 테스트 픽스처로 넣는다. 생성 RPC는 P2.
- `contracts/`: 세 JSON Schema에서 Go 구조체를 생성한다. 게이트웨이·코어·ingestion이 `backend/internal/contracts`를 쓴다.

성공: 같은 `message_created`를 두 번 publish해도 `messages` 행은 하나. 독성 1건은 DLQ로 가고 나머지 배치는 커밋된다. TDD: 마이그레이션 → JetStream 컨슈머 → 배치 플러시 → DLQ. 생성 타입이 그 페이로드를 직렬화한다. **완료.**

## P2 라이브챗 알파

목표: 내부 사용자가 위젯으로 상담원과 왕복한다.

- `gateway-web`: 위젯 WS, 상담원 WS, Contact/User 토큰 구독 격리, Client API 메시지 생성(이벤트 발행). 신규 대화는 `svc-core` 생성 RPC 성공 후에만 `message_created`.
- `svc-core`: FSM `unassigned`/`open`/`pending`/`resolved`, 컨택트·대화 PG 동기 커밋(Outbox), `version` CAS, Request-Reply.
- `frontend`: 큐 + 스레드(3-Pane 중 좌·중).
- `packages/widget-sdk`: iframe + origin 화이트리스트 `postMessage`.

성공: 외부 페이지 위젯 메시지 → core 생성 → NATS → PG → 상담원 화면, 답장이 위젯에 보인다. 동시에 두 전이를 보내면 하나만 커밋된다. snooze·카카오·이메일은 아직 없다. **완료.**

## P3 헬프데스크 MVP

목표: 한 팀이 웹 채널만으로 실제 상담을 끝낸다.

- shadcn/ui 도입. 기존 P3 프론트 화면(로그인, 큐, 인박스 멤버, 스레드 답장, 배정, 내부 메모, 스누즈, 라벨 부착, 첨부)을 shadcn 기반으로 마이그레이션한다.
- 로그인과 RBAC (`administrator`/`agent`). 자체 세션(이메일+비밀번호) + 짧은 만료 HMAC 접근 토큰. OIDC는 두지 않는다.
- `inbox_members`, 수동 배정, 내부 메모, snooze, 라벨, 매크로·저장응답.
- 첨부: SeaweedFS + `attachments`.
- Application API (대화·메시지·컨택트).
- `setUser` HMAC. administrator가 웹 인박스에서 시크릿 복사·즉시 회전.
- WebSocket은 짧은 만료 서명 토큰. `pubsub_token`은 시드로만 유지한다.
- 프론트 잔여 화면: 라벨 제거, 새로고침 후 대화 목록(GET 기본은 `resolved` 제외), 매크로·저장응답 UI, 티켓 `resolved` 버튼·해결 화면.

성공: 관리자가 상담원을 인박스에 넣고, 상담원이 메모·라벨·첨부로 티켓을 resolved 한다. **완료.**

## P4 옴니채널

- `gateway-email` 인입: SMTP `:25` + `emersion/go-smtp` / `go-message`. 웹훅 HMAC은 없고 MX DATA가 신뢰 경계. In-Reply-To / References → `messages.source_id`, 구분자 `##- Please type your reply above this line -##`, 제목 `[#REQ-{display_id}]`. 코어 생성 RPC(`reuse_contact`) 성공 뒤에만 JetStream `message_created`.
- `gateway-kakao`: 상담톡 30일 세션. 세션이 살아 있을 때만 상담톡 발송.
- `helpdesk.tasks.outbound.email` / `outbound.kakao`.
- 256KB 초과 본문·MIME은 오브젝트 스토리지 Claim-Check (`content_ref`).
- 고객 병합: `contact_merged` 이벤트, `contacts.merged_into_contact_id`. HMAC 통과 + 소스가 익명(identifier 없음)일 때만 티켓 `contact_id`를 기존 식별 컨택트로 옮긴다. 스레드는 합치지 않는다. `setUser` identify는 병합하지 않는다.

성공: 메일 회신이 기존 티켓에 붙는다. 카카오 세션이 살아 있으면 상담톡으로 나간다. 익명 웹 세션이 HMAC 통과하면 기존 식별 컨택트 티켓으로 붙고 스레드는 그대로다. `gateway-social`은 출시 후. **완료.**

## P5 운영 자동화

- `svc-sla-routing`: 온라인 + `C_current < C_max` 라운드로빈. `C_current`는 NATS JetStream KV 원자 증감, PG는 대사. 영업시간·부재중 greeting은 P9.
- `svc-automation`: Event → Conditions → Actions (`add_label`/`change_priority`/`send_webhook`). `hop_count > 5`면 드롭.
- SLA FRT/NRT/RT, `applied_slas`, breach 시 큐 플래그.
- resolved 시 CSAT (`content_type=input_csat`).

성공: 미배정 티켓이 자동 할당되고, FRT breach가 큐에 보인다. Pending은 NRT를 멈춘다. 동시에 들어온 티켓이 한 상담원 용량을 넘기지 않는다. resolved 뒤 위젯에 CSAT가 뜬다. **완료.**

## P5.5 상담 워크스페이스

목표: 상담원이 하루 수백 건을 키보드로 처리하는 대화 중심 셸과, 호스트 클릭을 가리지 않는 위젯을 P7 전에 고정한다. API·FSM은 바꾸지 않는다. TDD: [`frontend/src/App.test.jsx`](frontend/src/App.test.jsx)와 [레이아웃 설계안 §6](docs/UI_UX_레이아웃_설계안.md) ARIA 계약을 깨지 않고, 아래 항목별로 테스트 → 구현.

1. **실시간·인증 정합.** `store.js` `message.created`가 기존 대화의 `status`/`version`/`assigneeId`/`snoozedUntil`/`labels`/`slaBreached`를 유지한다. HTTP 401은 single-flight `POST /auth/refresh` 후 재시도하고, `session.token`과 WS 재연결 토큰을 같은 콜백으로 맞춘다.
2. **4-Zone 셸.** `Rail(56px)` + `Queue(320px)` + `Thread(flex-1, min 480px)` + `Context(300px)`. `>=1280px` 4영역, `1024–1279px` 컨텍스트는 드로어, `<1024px`는 큐/스레드 전환. 관리자 폼(인박스 멤버·HMAC·카탈로그)은 레일의 설정 뷰로 분리한다. 대기열 필터 탭(전체/내 담당/미배정)과 URL 복원은 출시 후 결정을 유지한다.
3. **스레드 밀도.** 헤더 `52px`에 배정(멤버 Select + 나에게 배정)·스누즈(프리셋 + `datetime-local`)·매크로 실행·대기/해결. 라벨·채널·SLA 잔여는 우측 컨텍스트. 타임라인은 고객/상담원/내부메모 버블. 하단 통합 컴포저(답장↔메모 탭, 첨부, `/` 저장응답 팝오버). 큐 카드는 3행(채널·번호·SLA / lastContent / 라벨·unread). 레거시 `#ddd` CSS를 시맨틱 토큰으로 교체한다. 단축키: `J`/`K` 큐 이동, `R` 답장, `N` 메모, `⌘/Ctrl+Enter` 전송, `E` 해결.
4. **위젯.** 호스트 Shadow DOM 런처(`60×60`) + 열릴 때만 교차출처 iframe(`380×640`, 모바일 `100vw×100dvh`). `init` 시드 `pubsub_token`은 `POST /public/api/v1/inboxes/{id}/auth`로 짧은 접근 토큰과 교환하고 만료 시 재교환. `send`마다 WS를 만들지 않는다. `{helpdeskOrigin}/widget.html` 엔트리와 로더 번들. P5 `input_csat` 카드 슬롯.

성공: 관리자 설정이 대기열을 가리지 않고, 대화 선택 시 타임라인+컴포저가 중앙 높이의 대부분이다. 실시간 메시지 직후 배정/해결 CAS가 통과한다. 로그인 15분 뒤 HTTP가 갱신된다. 닫힌 위젯은 런처 밖 호스트 클릭을 막지 않고, 메시지를 여러 번 보내도 WS·수신은 한 겹이다. TypeScript 코드젠·가상 스크롤·티켓 URL 딥링크는 이 마일스톤에 넣지 않는다. **완료.**

## P6 플랫폼

- Client API 정식화: Contact 스코프 대화 목록·메시지 GET/POST (`/public/api/v1/inboxes/{inbox_id}/contacts/{contact_id}/conversations...`). 기존 `POST .../messages`는 유지.
- Platform API: `POST`/`GET`/`PATCH`/`DELETE /platform/api/v1/accounts`, `POST`/`GET`/`PATCH`/`DELETE /platform/api/v1/users`. Bearer `AURA_PLATFORM_TOKEN`. 계정 생성은 administrator+웹 인박스. 운영 스크립트 `deploy/operator/`.
- HMAC 아웃바운드 웹훅 + 재시도 큐 (`helpdesk.tasks.webhooks.deliver`). `message_created` 구독 fanout과 자동화 `send_webhook`. 헤더 `X-Helpdesk-Signature`/`X-Helpdesk-Timestamp`.
- 리포트: 대화 / 상담원 / 인박스 / CSAT%(4–5점 비율) / SLA hit rate. P5.5 설정 뷰 위에 올린다.
- Help Center `articles` + 위젯 검색. P5.5 `widget.html` 위에 올린다.

성공: 외부 CRM이 `message_created` 웹훅을 검증해 받고, 관리자가 CSAT%와 SLA hit rate를 본다. **완료.**

## P7 AI-Native 출시

- `svc-ai-agent`: Ego-Graph 1~2홉 읽기, ReAct/Tool, 저위험 자동 아웃바운드, 고위험 승인 카드, resolved 시 ontology extract.
- P5.5 컨텍스트 패널에 Living Profile, 스레드에 도구 승인 카드. 셸·브레이크포인트는 바꾸지 않는다.
- 채널별 rate limit·서킷브레이커.
- 임베딩을 본 테이블에서 분리(`model`/`version` 메타, `halfvec(1536)`, HNSW `m=16`/`ef_construction=64`, article 부분 인덱스). AI RAG는 현재 모델만 cosine(`ef_search=40`). `ontology_edges` 시간 유효성(`valid_from`/`valid_until`).
- JetStream → 오브젝트 스토리지 날짜별 JSONL Cold Event 아카이브. 고객 파기 시 PG 익명화(식별자·본문·CSAT·도구 JSON) + subject purge API. AI 이벤트는 `hop_count+1`·`causation_id`로 자동화 루프를 끊는다.
- `deploy/k8s/base/`, `deploy/SETUP.md`, `.github/workflows/ci.yml` — 이 시점에 실제 배포·PR이 생길 때 추가.

성공: 웹+메일+카카오로 **파일럿 테넌트 1곳**이 돌아간다. 이 마일스톤이 제품 출시 선. **완료.**

## P8 LangChain create_agent · Skills · MCP

목표: P7 손수 ReAct 루프를 LangChain `create_agent` 하네스로 옮긴다. Aura 고유 행위는 네이티브 도구, 테넌트 운영계(주문·배송·환불·해지·플랜)는 MCP, 절차 플레이북은 Agent Skills다. NATS 승인 카드·Zero DB Write·`hop_count`는 유지한다.

- `svc-ai-agent`: `create_agent` + 미들웨어(Ego/RAG 주입, Skills `load_skill`, `ToolCallLimitMiddleware(run_limit=8)`, `ModelRetryMiddleware`, AuraHITL). DeepAgents·LangGraph checkpointer HITL은 두지 않는다. 키 없으면 결정적 stub 모델 + in-process FastMCP.
- 네이티브 도구는 `send_status`(outgoing `message_created` + 채널 outbound). 운영계 도구는 테넌트 `mcp_servers` Streamable HTTP. 고위험(`refund`/`cancel_subscription`/`change_plan` 또는 서버 `high_risk_tools`·destructive annotation)은 승인 카드 뒤에만 MCP를 호출한다. `auth_header`는 이벤트 payload에 넣지 않는다.
- Agent Skills: 리포 `svc-ai-agent/skills/*/SKILL.md` + 테이블 `agent_skills` 테넌트 덮어쓰기(같은 `name` last-wins). Help Center RAG(article cosine top-5)는 그대로. 상담원 Skill 라우팅(출시 후)과 이름을 구분한다.
- administrator 설정: `mcp_servers`·`agent_skills` CRUD. 시크릿은 HMAC처럼 GET에서 가리고 회전에 덮어쓴다. P5.5 셸·브레이크포인트는 바꾸지 않는다.

성공: 기존 P7 행위 테스트(hop, 저위험 outbound, 환불 승인 카드, Ego/RAG, 키 없음 stub)가 통과한다. 환불은 승인 후에만 운영계 MCP를 친다. 테넌트 스킬이 리포 스킬을 덮어쓴다. **완료.**

## P9 운영 공백

목표: P5가 완료로 적었지만 비어 있던 presence·영업시간·부재중 greeting과, 계약만 있던 typing을 채운다. 셸·브레이크포인트·FSM은 바꾸지 않는다.

- Presence: User WS connect → `helpdesk.rpc.auth.presence` `online`, disconnect → `offline`. `users.availability_status` last-write-wins. `helpdesk.realtime.<account_id>.agent.presence`. Contact는 호출하지 않는다. 멀티탭 카운트는 출시 후.
- 영업시간: `inboxes.business_hours` `{timezone, week:{mon:[["09:00","18:00"]], …}}`. `enabled=false` 또는 `{}`는 24/7. 키 없음/빈 배열은 그날 휴무. 영업시간 밖이면 자동배정하지 않는다. `sla_policies.only_business_hours`면 FRT/NRT/RT due는 인박스 영업시간만 가산.
- 부재중 greeting: 영업시간 밖이거나 온라인 풀이 비면 `helpdesk.rpc.conversations.greet`. `greeting_message`를 AgentBot outgoing 1회. 같은 대화·같은 본문이 있으면 no-op.
- Typing: WS `{type:"typing",conversation_id,is_typing}` → NATS Core `helpdesk.realtime.<account_id>.<conversation_id>.typing`. PG에 쓰지 않는다. SPA·위젯 debounce ~400ms.
- 관리자: `GET` 인박스에 greeting/hours, `PATCH /api/v1/accounts/{id}/inboxes/{inbox_id}` → `helpdesk.rpc.inboxes.update`. HMAC 패널을 인박스 설정으로 확장.

성공: 상담원 WS 연결 후 미배정 티켓이 자동 배정되고, 끊으면 풀에서 빠진다. 영업시간 밖 인입은 미배정 + greeting 1회 + FRT due가 다음 오픈 이후로 밀린다. 타이핑 인디케이터가 상대에게 보이고 `messages` 행은 없다. **완료.**

## P10 인박스 설정

목표: 채널 타입은 게이트웨이 능력이고, 계정 administrator가 설정에서 인박스를 만든 뒤 멤버를 붙인다. `channels` 테이블은 없다.

- `AURA_ENABLED_CHANNELS`(ConfigMap `aura-config`, 기본 `web,email,kakao`). `GET /api/v1/accounts/{id}/channels`. `social`·알 수 없는 값은 버린다. 비면 기본값.
- 인박스 CRUD: `inboxes.list` / `create` / `delete`, `inboxes.update`는 있는 키만. 생성은 actor를 멤버로 넣고 HMAC을 만든다. `email`은 `email_address`, `kakao`는 `kakao_sender_key`.
- 설정 내비: 인박스 → 인박스 멤버 → HMAC. 멤버·HMAC Select는 인박스 이름.

성공: 관리자가 웹·메일·카카오 인박스를 만들고 이름을 고치고 지운 뒤, 그 인박스에 멤버를 넣는다. 계정 시드 웹 인박스는 그대로다. **완료.**

## 출시 후

- 카카오 알림톡: 세션 밖 승인 템플릿·전화번호 발송
- `gateway-social` (WhatsApp 24시간 창, SMS)
- 상담원 Skill/Team 라우팅 고도화 (티켓을 상담원 스킬·팀으로 나눈다. P8 `agent_skills` 플레이북과 다른 개념)
- PG 읽기 복제본
- 멀티리전 첨부 버킷
- `messages` 등 대용량 테이블 UUIDv7 범위 파티셔닝(PK는 `id` 유지)
- Task Fair Queuing(테넌트 쿼터)
- presence 연결 카운트 (멀티탭·멀티 레플리카). last-write-wins를 KV 증감으로 교체
- 상담원 큐 폴더: Mine/미배정/전체 + 상태 탭. 필터를 URL에 넣어 새로고침이 그 뷰를 복원. 라벨 폴더·저장 뷰. 티켓 딥링크.
- 큐/메시지 가상 스크롤.
- 상담원 SPA TypeScript: `frontend/` 소스·테스트·Vite 설정은 `.ts/.tsx`다. `packages/widget-sdk` 코드젠·TS 전환은 출시 후.
- `contracts/` JSON Schema → TypeScript (`frontend/`, `packages/widget-sdk`). 게이트웨이가 `helpdesk.realtime`에 넣는 WS 래퍼의 `message` 필드는 이미 `message_created` envelope이므로, 그 envelope·payload만 생성 타입으로 읽는다. NATS RPC(`conversations.create` 등)는 게이트웨이↔코어 전용이다. REST 응답·UI 상태·위젯 호스트 `postMessage`(`source: "aura-widget"`)는 이 스키마에 합치지 않는다. Go 생성은 지금처럼 `backend/internal/contracts`다. 이 코드젠은 `store`/`gateway`가 `.ts`인 뒤에 WS 경계에만 붙인다.

## 미결정

아직 고르지 않은 항목만 둔다. 고르면 아래 결정 로그로 옮긴다. 표 열은 `항목` / `선택지` / `기본 가정`이다.

현재 없음.

## 결정 로그

고른 항목만 둔다. 계약으로 승격된 내용은 [ARCHITECTURE.md](ARCHITECTURE.md)를 따른다.

**LLM 벤더.** OpenAI 호환 / 기타 → OpenAI 호환 Chat Completions + native tool calling. `AURA_LLM_BASE_URL`(기본 `https://api.openai.com/v1`) · `AURA_LLM_API_KEY` · `AURA_LLM_MODEL`(기본 `gpt-4o-mini`) · `AURA_EMBEDDING_MODEL`(기본 `text-embedding-3-small`). 키가 비면 결정적 stub. 본 테이블 `vector(1536)`은 `embeddings`로 분리하고 `model`/`version`으로 세대 구분. P8 추론은 LangChain `create_agent`가 같은 엔드포인트를 쓴다.

**운영계 MCP.** 테넌트 URL / 인프로세스 stub → 테넌트 `mcp_servers.url`(https Streamable HTTP). 서버가 없으면 in-process FastMCP stub(현재 lookup/refund JSON). Aura 서비스 사이 MCP는 두지 않는다.

**Agent Skills 저장.** 리포만 / 테넌트 덮어쓰기 → 리포 `SKILL.md` 기본 + `agent_skills` 테넌트 last-wins.

**NATS 격리.** account 대 subject prefix `helpdesk.events.<account_id>.>` → 출시는 subject prefix. NATS account 격리는 출시 후.

**첨부 버킷.** 테넌트 prefix vs 버킷 분리 → P3는 SeaweedFS 필러 단일 트리 + `account_id/` prefix. 버킷 분리·멀티리전은 출시 후.

**Auth.** 자체 세션 vs OIDC → 자체 세션(이메일+비밀번호). Argon2id. 세션 쿠키(7일, HttpOnly) + HMAC 접근 토큰(15분, `exp`·`sid`). `pubsub_token`은 시드. OIDC는 P6 이후 검토.

**스누즈 깨움.** PG `conversations.snoozed_until`은 상태 컬럼으로 유지한다. 시각 도래의 주체는 NATS JetStream 스케줄 메시지(`Nats-Schedule: @at`, 스트림 `AllowMsgSchedules`)다. 게이트웨이는 스케줄만 발행하고, `svc-core` 컨슈머가 `helpdesk.tasks.snooze.wake.*`를 받아 FSM으로 `open` 전이한다.

**라벨·매크로·저장응답 (A안).** 라벨은 분류(주제·고객 신호·다음 일), 저장응답은 `/short_code` 문장, 매크로는 상담원이 고른 뒤에만 도는 작업 묶음. 자동화는 P5. 카탈로그·공유 저장응답·`visibility=account` 매크로는 administrator가 만들고, 상담원은 있는 라벨만 붙이거나 떼고 `personal` 매크로만 만든다. 매크로 `actions`는 `send_message` / `add_label` / `add_private_note` / `assign_agent` / `snooze_conversation` / `resolve_conversation`.

**setUser 이후 익명 대화.** P3는 합치지 않는다. HMAC이 맞으면 현재 컨택트에 identifier만 찍고, 다른 컨택트와 겹치면 거절한다. P4 `contact_merged`가 HMAC 통과 + 익명 소스일 때만 티켓의 `contact_id`를 기존 식별 컨택트로 옮긴다. 스레드는 합치지 않는다.

**해결 화면 pending.** 스레드 해결 영역에 `pending` 버튼을 둔다. 큐에는 남고, `resolved`만 숨긴다. `unassigned`/`open`에서 `pending`으로 간다.

**인박스 HMAC 시크릿.** administrator만 웹 인박스 설정에서 보고 복사한다. Agent·Client API·위젯에는 내려가지 않는다. 호스트 서버가 env에 넣고 `identifier_hash`만 페이지에 심는다. 회전은 `hmac_secret`을 즉시 덮어쓰고, 이전 키·`hmac_mandatory`는 두지 않는다. 이메일/카카오 인박스는 이 키를 쓰지 않는다.

**대화 목록 필터 (B안).** `GET /conversations`와 `conversations.list` 기본은 작업 큐다. `resolved`는 내려주지 않는다. 담당자·Mine/미배정 쿼리는 두지 않는다. 화면은 미래 `snoozed`를 숨긴다. Mine/미배정/전체 + 상태 탭과 URL 복원·라벨 폴더는 출시 후.
