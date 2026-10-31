# backend

`svc-ingestion-worker`, `svc-core`, `gateway-web`, `gateway-email`, `gateway-kakao`, PostgreSQL 마이그레이션. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md).

## 내부 설계

- NATS 페이로드 타입은 [contracts/](../contracts/) JSON Schema에서 생성한다. `go-jsonschema`는 draft-07만 받아 2020-12 스키마와 안 맞고, 검증 코드까지 뽑아서 쓰지 않는다. `go generate ./internal/contracts`가 짧은 생성기로 `internal/contracts` 구조체를 만든다. 게이트웨이·코어·ingestion이 그 타입으로 `message_created`와 `conversations.create`/`transition`을 직렬화한다.
- 런타임 롤은 `aura_app` (`NOBYPASSRLS`). 슈퍼유저 DSN은 마이그레이션·시드만 쓴다.
- 워커는 기동 시 스트림 `CONVERSATIONS_STREAM`, `TASKS_STREAM`(`AllowMsgSchedules`), `INGESTION_DLQ`를 보장하고, durable pull consumer `ingestion`으로 `message_created`와 `csat_submitted`를 Fetch한다. `svc-core` durable `svc-core-webhook-fanout`은 `message_created`를 구독 웹훅에 팬아웃하고, `svc-core-webhooks`가 `helpdesk.tasks.webhooks.deliver`를 HMAC POST한다. 배치 상한 500건, 대기 100ms. `svc-sla-routing` durable `sla-routing`은 `message_created`로 미배정 티켓을 온라인·`C_current < auto_assignment_capacity` 멤버에게 라운드로빈한다. `C_current`는 KV `AGENT_CAPACITY`에서 revision CAS로만 올린다. 전이는 `conversations.assign` RPC다. 계정 `sla_policies`가 있으면 인입 시 `applied_slas`에 FRT/NRT/RT due를 찍고, due가 지나면 breach. Pending이면 NRT는 평가하지 않는다. 목록 `sla_breached`가 큐 플래그다. `svc-automation` durable `svc-automation`은 `message_created`를 받아 `hop_count > 5`면 드롭하고, 아니면 `automation_rules` Event→Conditions→Actions(`add_label`/`change_priority`)를 적용한다. `resolved`면 `svc-core`가 `content_type=input_csat` 메시지를 같은 트랜잭션에 넣고, 고객은 Contact API로 `csat_submitted`를 보낸다.
- 플러시는 `account_id`로 묶고, 그룹마다 `set_config('app.current_account_id', …, true)` 후 `INSERT … ON CONFLICT (id) DO NOTHING` 한다. 배치 실패 시 단건으로 폴백하고, 영구 실패는 `helpdesk.dlq.ingestion`에 `{ "error", "raw" }`를 넣은 뒤 원본 ACK.
- `svc-core`는 `helpdesk.rpc.conversations.create` / `transition` / `assign` / `note` / `snooze` / `label.*` / `labels.*` / `canned.*` / `macros.*` / `inboxes.get` / `inboxes.rotate_hmac` / `conversations.email_reply` / `conversations.kakao_reply` / `inboxes.resolve_kakao` / `conversations.resolve_kakao` / `contacts.identify` / `auth.contact`을 queue group `svc-core`로 받는다. 익명 컨택트의 HMAC identify가 기존 identifier와 겹치면 `merged_into_contact_id`를 찍고 그 컨택트 티켓의 `contact_id`만 옮긴 뒤 `contact_merged`를 outbox에 넣는다. 대화 행은 합치지 않는다. 생성은 컨택트·인박스링크·`account_sequences` 채번·대화(`unassigned`, `version=1`)를 한 트랜잭션에 넣는다. 전이는 허용표 + `version` CAS이고, 성공 시 `event_outbox`에 `status_changed`를 쓴 뒤 JetStream에 발행한다. 스누즈는 `unassigned`/`open` → `snoozed` + `snoozed_until`이다. 깨움은 게이트웨이가 발행한 JetStream 스케줄(`Nats-Schedule: @at`)을 durable `svc-core-snooze`(필터 `helpdesk.tasks.snooze.wake.*`)가 받아 `WakeDue`로 `open`한다. 수동 배정은 대상이 해당 인박스 `inbox_members`여야 하고, `administrator` 또는 그 인박스 멤버만 호출한다. `unassigned`면 `open`으로 올린다. 내부 메모는 `messages.private=true`이고 Contact WS에는 나가지 않는다. 라벨 카탈로그 생성은 `administrator`만. 티켓 부착은 있는 이름만 조인하고, 없는 이름은 administrator만 upsert한다. 제거는 join만 지운다. 저장응답 생성은 administrator, 목록은 계정 멤버. 매크로 생성 시 agent는 `visibility=personal`로 강제하고, 실행은 account 매크로 또는 본인 personal만, 액션은 기존 쓰기 함수를 순서대로 호출한다.
- `gateway-web`은 PG에 붙지 않는다. 접근 토큰은 HMAC 클레임에 `exp`·`sid`가 있는 15분 토큰이다. Contact는 `account_id`·`inbox_id`·`source_id`(생성 후 `conversation_id`), User는 `account_id`·`inbox_ids`. 로그인·리프레시·로그아웃은 `helpdesk.rpc.auth.*` → `svc-core`. Contact 시드 교환은 `POST /public/api/v1/inboxes/{inbox_id}/auth` → `helpdesk.rpc.auth.contact`이고, RLS 밖 조회는 SECURITY DEFINER `auth_contact_seed`다. `{helpdeskOrigin}/widget.html`·`aura-loader.min.js`·`widget.min.js`·`sdk.js`·`widget.js`는 `AURA_WIDGET_DIR`(기본 `../packages/widget-sdk`) 정적 파일이다. 세션 쿠키 `aura_session`은 opaque 난수이고 DB에는 SHA-256만 둔다. `pubsub_token`은 시드다. `setUser` HMAC은 `helpdesk.rpc.contacts.identify`가 `inboxes.hmac_secret`으로 검증한다. 익명 컨택트고 같은 identifier가 있으면 identify는 identifier를 쓰지 않고 `contact_merged`로 티켓 `contact_id`만 옮긴다. 시크릿 열람·회전은 `helpdesk.rpc.inboxes.get` / `inboxes.rotate_hmac`이고 administrator만이다. 회전은 `crypto/rand` 32바이트 hex로 컬럼을 즉시 덮어쓴다.
- `gateway-email`은 PG에 붙지 않는다. SMTP `:25`에서 DATA MIME을 받아 `helpdesk.rpc.inboxes.resolve_email` / `conversations.resolve_thread`로 인박스·스레드를 찾고, 없으면 `conversations.create`(`reuse_contact=true`)가 성공한 뒤에만 `message_created`를 발행한다. From은 `contact_inboxes.source_id`, Message-ID는 `messages.source_id`다. 상담원 답장은 `gateway-web`이 `conversations.email_reply`로 채널을 보고, 이메일이면 `helpdesk.tasks.outbound.email`을 넣는다. `gateway-email` durable `gateway-email-outbound`가 MIME(`[#REQ-{display_id}]`, In-Reply-To, 회신 구분자)을 `AURA_SMTP_RELAY`로 보낸다.
- `gateway-kakao`는 PG에 붙지 않는다. `POST /cstalk/message` 웹훅을 받아 `helpdesk.rpc.inboxes.resolve_kakao` / `conversations.resolve_kakao`로 인박스·미해결 스레드를 찾고, 없으면 `conversations.create`(`reuse_contact=true`)가 성공한 뒤에만 `message_created`를 발행한다. `userKey`는 `contact_inboxes.source_id`, `msgKey`는 `messages.source_id`다. 본문은 `contents[].comment`다. 응답은 `{"code":"A000","result":"Success"}`. 상담원 답장은 `gateway-web`이 `conversations.kakao_reply`로 채널·30일 세션을 보고, 세션이 살아 있을 때만 `helpdesk.tasks.outbound.kakao`를 넣는다. durable `gateway-kakao-outbound`가 상담톡 Plain을 `AURA_KAKAO_API_URL`로 보낸다. 세션이 꺼져 있으면 티켓에만 남긴다.
- 로그인은 테넌트 GUC 이전이다. `account_users`/`inbox_members` 스냅샷은 SECURITY DEFINER `auth_login_membership(user_id)`만 쓴다. 인박스 멤버 추가·삭제는 `administrator`만 `helpdesk.rpc.inbox_members.*`로 한다.
- 첨부는 SeaweedFS 필러 HTTP다. 게이트웨이는 PG에 쓰지 않고 `{account_id}/{attachment_id}/{filename}`에 PUT한 뒤 `message_created.payload.attachments`에 URL만 넣는다. ingestion이 `attachments` 행을 `ON CONFLICT (id) DO NOTHING`으로 넣는다.
- Platform API는 게이트웨이가 PG에 쓰지 않는다. `AURA_PLATFORM_TOKEN` Bearer가 맞을 때만 `helpdesk.rpc.platform.accounts.create` / `users.create`로 넘긴다. 계정 생성은 `accounts`+administrator `users`/`account_users`+웹 인박스(HMAC 시크릿)를 한 트랜잭션에 넣는다.
- Client API `POST /public/api/v1/inboxes/{inbox_id}/messages`: 토큰에 대화 ID가 없으면 `helpdesk.rpc.conversations.create`가 성공한 뒤에만 `message_created`와 `helpdesk.realtime.<account_id>.<conversation_id>.updated`를 발행한다. RPC 실패 시 둘 다 없다. 기존 대화는 create를 건너뛴다. 정식 경로는 `.../contacts/{contact_id}/conversations` 목록·메시지 GET과 `.../conversations/{id}/messages` POST다. Contact 토큰의 `inbox_id`/`contact_id`가 경로와 같아야 한다.
- 웹훅: administrator CRUD. `message_created` fanout(`svc-core-webhook-fanout`)과 자동화 `send_webhook`가 `helpdesk.tasks.webhooks.deliver`를 넣는다. durable `svc-core-webhooks`가 HMAC (`X-Helpdesk-Signature: sha256=`, `X-Helpdesk-Timestamp`)으로 POST한다. 본문은 envelope를 펼친 `{ id, event, occurred_at, account_id, inbox_id, conversation_id, trace_id, payload }`. 5xx·네트워크는 NAK(최대 5).
- 리포트 RPC `reports.get`는 administrator만. `csat_percent`는 rating≥4 비율, `sla_hit_rate`는 applied_slas 중 FRT/NRT/RT 모두 미위반 비율. 분모 0이면 0.
- Help Center: administrator가 `articles`를 만들고, 위젯은 `GET /public/api/v1/inboxes/{inbox_id}/articles?q=` → `articles.search`(SECURITY DEFINER, `published`만, title/body ILIKE). 생성 시 `helpdesk.tasks.ai.embed`가 나가고 `svc-ai-agent`가 `embedding_upsert`를 발행한다. `articles.embedding`/`ontology_nodes.embedding` 컬럼은 없고 `embeddings(model, version, halfvec, HNSW m=16)`만 쓴다. AI RAG는 현재 모델/버전 cosine(`<=>`, `hnsw.ef_search=40`) top-5, 위젯 검색은 ILIKE.
- P8: administrator만 `mcp_servers`·`agent_skills` CRUD. MCP `auth_header`는 HMAC처럼 GET에서 내려주고 회전은 컬럼을 덮어쓴다. `svc-ai-agent`는 두 테이블을 SELECT만 한다.
- P7: `svc-core` resolved 시 `helpdesk.tasks.ontology.extract`를 발행한다. `ontology.ego`는 유효 엣지 1~2홉 `LIMIT 50`. `tools.approve`는 승인 이벤트와 `helpdesk.tasks.ai.execute`를 낸다. `contacts.purge`는 PG PII(식별자·본문·CSAT 피드백·도구 입출력)를 익명화하고 해당 대화 JetStream subject와 archive prefix를 지운다. 고객 인입 `message_created` 뒤에 `helpdesk.tasks.ai.reasoning`을 넣는다. AI가 내는 이벤트는 `hop_count+1`과 `causation_id`를 붙인다. ingestion은 `tool_execution`/`ontology_extracted`/`embedding_upsert`를 멱등 적재한다. 아웃바운드는 채널별 rate limit·서킷브레이커. `event-archive`는 Limits 스트림을 SeaweedFS `archive/{account_id}/{conversation_id}/{yyyy-mm-dd}.jsonl`에 NDJSON append한다.
- Application API `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`: User 토큰의 `inbox_ids`에 요청 `inbox_id`가 있을 때만 outgoing `message_created`. 대화 행 조회가 없으므로 바디에 `inbox_id`·`contact_id`·`contact_inbox_id`가 필요하다. 이메일 인박스면 `conversations.email_reply`가 스킵이 아닐 때 `payload.source_id`를 Message-ID로 넣고 `helpdesk.tasks.outbound.email`을 발행한다. 카카오면 `conversations.kakao_reply`가 세션이 살아 있을 때만 `helpdesk.tasks.outbound.kakao`를 발행한다.
- Application API 목록은 게이트웨이 HTTP → `helpdesk.rpc.conversations.list` / `messages` / `contacts.list`. 배속 인박스만. 대화 목록 기본은 `status <> 'resolved'`. 행에 `display_id`·`channel_type`·`sla_breached`·`contact_name`·`contact_email`·`last_activity_at`·`applied_slas`(FRT/NRT/RT due). 담당자 쿼리는 두지 않는다. `PUT .../status`는 기존 transition RPC다.
- WS `GET /ws?token=`: Contact는 자기 `conversation_id`만, User는 클레임 `inbox_ids`에 속한 대화만 받는다. 연결 후 `{"type":"ready"}`. Origin은 비어 있거나 `http`/`https`만 허용한다. SPA는 접근 토큰이 바뀌면 재연결한다.

## Commands

저장소 루트 기준.

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend
go generate ./internal/contracts
go test ./...
go run ./cmd/ingestion-worker
go run ./cmd/svc-core
go run ./cmd/gateway-web
go run ./cmd/gateway-email
go run ./cmd/gateway-kakao
go run ./cmd/svc-sla-routing
go run ./cmd/svc-automation
go run ./cmd/event-archive
```

환경변수: `AURA_MIGRATE_DSN` (슈퍼유저), `AURA_DSN` (`aura_app`), `AURA_NATS_URL`, `AURA_TOKEN_SECRET` (`gateway-web`), `AURA_PLATFORM_TOKEN` (Platform API Bearer), `AURA_HTTP_ADDR` (기본 `:8080`), `AURA_WIDGET_DIR`(기본 `../packages/widget-sdk`), `AURA_SMTP_ADDR` (기본 `:25`), `AURA_SMTP_RELAY`(아웃바운드, 기본 `127.0.0.1:2525`), `AURA_KAKAO_ADDR`(기본 `:8081`), `AURA_KAKAO_API_URL`, `AURA_KAKAO_API_KEY`, `AURA_FILER_URL`(기본 `http://127.0.0.1:8888`), `AURA_FILER_PUBLIC_URL`(이벤트 URL, 비면 `AURA_FILER_URL`). `event-archive`는 같은 filer URL에 `archive/{account_id}/{conversation_id}/{yyyy-mm-dd}.jsonl`을 NDJSON append한다. 아웃바운드 한도 `AURA_OUTBOUND_RPS`(기본 20), 서킷 `AURA_CIRCUIT_FAILURES`(기본 5)·`AURA_CIRCUIT_OPEN`(기본 30s).

`gateway-email` SMTP 문서상 기본 포트는 `25`다. 에릭은 `:2050`에서 실행한다. 포트는 `AURA_SMTP_ADDR`로 바꾼다.
