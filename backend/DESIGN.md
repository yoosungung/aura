# backend

`svc-ingestion-worker`, `svc-core`, `gateway-web`, `gateway-email`, PostgreSQL 마이그레이션. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md).

## 내부 설계

- NATS 페이로드 타입은 [contracts/](../contracts/) JSON Schema에서 생성한다. `go-jsonschema`는 draft-07만 받아 2020-12 스키마와 안 맞고, 검증 코드까지 뽑아서 쓰지 않는다. `go generate ./internal/contracts`가 짧은 생성기로 `internal/contracts` 구조체를 만든다. 게이트웨이·코어·ingestion이 그 타입으로 `message_created`와 `conversations.create`/`transition`을 직렬화한다.
- 런타임 롤은 `aura_app` (`NOBYPASSRLS`). 슈퍼유저 DSN은 마이그레이션·시드만 쓴다.
- 워커는 기동 시 스트림 `CONVERSATIONS_STREAM`, `TASKS_STREAM`(`AllowMsgSchedules`), `INGESTION_DLQ`를 보장하고, durable pull consumer `ingestion`으로 `helpdesk.events.*.*.*.message_created`만 Fetch한다. 배치 상한 500건, 대기 100ms.
- 플러시는 `account_id`로 묶고, 그룹마다 `set_config('app.current_account_id', …, true)` 후 `INSERT … ON CONFLICT (id) DO NOTHING` 한다. 배치 실패 시 단건으로 폴백하고, 영구 실패는 `helpdesk.dlq.ingestion`에 `{ "error", "raw" }`를 넣은 뒤 원본 ACK.
- `svc-core`는 `helpdesk.rpc.conversations.create` / `transition` / `assign` / `note` / `snooze` / `label.*` / `labels.*` / `canned.*` / `macros.*` / `inboxes.get` / `inboxes.rotate_hmac`을 queue group `svc-core`로 받는다. 생성은 컨택트·인박스링크·`account_sequences` 채번·대화(`unassigned`, `version=1`)를 한 트랜잭션에 넣는다. 전이는 허용표 + `version` CAS이고, 성공 시 `event_outbox`에 `status_changed`를 쓴 뒤 JetStream에 발행한다. 스누즈는 `unassigned`/`open` → `snoozed` + `snoozed_until`이다. 깨움은 게이트웨이가 발행한 JetStream 스케줄(`Nats-Schedule: @at`)을 durable `svc-core-snooze`(필터 `helpdesk.tasks.snooze.wake.*`)가 받아 `WakeDue`로 `open`한다. 수동 배정은 대상이 해당 인박스 `inbox_members`여야 하고, `administrator` 또는 그 인박스 멤버만 호출한다. `unassigned`면 `open`으로 올린다. 내부 메모는 `messages.private=true`이고 Contact WS에는 나가지 않는다. 라벨 카탈로그 생성은 `administrator`만. 티켓 부착은 있는 이름만 조인하고, 없는 이름은 administrator만 upsert한다. 제거는 join만 지운다. 저장응답 생성은 administrator, 목록은 계정 멤버. 매크로 생성 시 agent는 `visibility=personal`로 강제하고, 실행은 account 매크로 또는 본인 personal만, 액션은 기존 쓰기 함수를 순서대로 호출한다.
- `gateway-web`은 PG에 붙지 않는다. 접근 토큰은 HMAC 클레임에 `exp`·`sid`가 있는 15분 토큰이다. Contact는 `account_id`·`inbox_id`·`source_id`(생성 후 `conversation_id`), User는 `account_id`·`inbox_ids`. 로그인·리프레시·로그아웃은 `helpdesk.rpc.auth.*` → `svc-core`. 세션 쿠키 `aura_session`은 opaque 난수이고 DB에는 SHA-256만 둔다. `pubsub_token`은 시드다. `setUser` HMAC은 `helpdesk.rpc.contacts.identify`가 `inboxes.hmac_secret`으로 검증한다. 시크릿 열람·회전은 `helpdesk.rpc.inboxes.get` / `inboxes.rotate_hmac`이고 administrator만이다. 회전은 `crypto/rand` 32바이트 hex로 컬럼을 즉시 덮어쓴다.
- `gateway-email`은 PG에 붙지 않는다. SMTP `:25`에서 DATA MIME을 받아 `helpdesk.rpc.inboxes.resolve_email` / `conversations.resolve_thread`로 인박스·스레드를 찾고, 없으면 `conversations.create`(`reuse_contact=true`)가 성공한 뒤에만 `message_created`를 발행한다. From은 `contact_inboxes.source_id`, Message-ID는 `messages.source_id`다.
- 로그인은 테넌트 GUC 이전이다. `account_users`/`inbox_members` 스냅샷은 SECURITY DEFINER `auth_login_membership(user_id)`만 쓴다. 인박스 멤버 추가·삭제는 `administrator`만 `helpdesk.rpc.inbox_members.*`로 한다.
- 첨부는 SeaweedFS 필러 HTTP다. 게이트웨이는 PG에 쓰지 않고 `{account_id}/{attachment_id}/{filename}`에 PUT한 뒤 `message_created.payload.attachments`에 URL만 넣는다. ingestion이 `attachments` 행을 `ON CONFLICT (id) DO NOTHING`으로 넣는다.
- Client API `POST /public/api/v1/inboxes/{inbox_id}/messages`: 토큰에 대화 ID가 없으면 `helpdesk.rpc.conversations.create`가 성공한 뒤에만 `message_created`와 `helpdesk.realtime.<account_id>.<conversation_id>.updated`를 발행한다. RPC 실패 시 둘 다 없다. 기존 대화는 create를 건너뛴다.
- Application API `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`: User 토큰의 `inbox_ids`에 요청 `inbox_id`가 있을 때만 outgoing `message_created`. 대화 행 조회가 없으므로 바디에 `inbox_id`·`contact_id`·`contact_inbox_id`가 필요하다.
- Application API 목록은 게이트웨이 HTTP → `helpdesk.rpc.conversations.list` / `messages` / `contacts.list`. 배속 인박스만. 대화 목록 기본은 `status <> 'resolved'`. 담당자 쿼리는 두지 않는다. `PUT .../status`는 기존 transition RPC다.
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
```

환경변수: `AURA_MIGRATE_DSN` (슈퍼유저), `AURA_DSN` (`aura_app`), `AURA_NATS_URL`, `AURA_TOKEN_SECRET` (`gateway-web`), `AURA_HTTP_ADDR` (기본 `:8080`), `AURA_SMTP_ADDR` (기본 `:25`), `AURA_FILER_URL`(기본 `http://127.0.0.1:8888`), `AURA_FILER_PUBLIC_URL`(이벤트 URL, 비면 `AURA_FILER_URL`).

`gateway-email` SMTP 문서상 기본 포트는 `25`다. 에릭은 `:2050`에서 실행한다. 포트는 `AURA_SMTP_ADDR`로 바꾼다.
