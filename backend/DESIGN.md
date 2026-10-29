# backend

`svc-ingestion-worker`, `svc-core`, `gateway-web`, PostgreSQL 마이그레이션. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md).

## 내부 설계

- 런타임 롤은 `aura_app` (`NOBYPASSRLS`). 슈퍼유저 DSN은 마이그레이션·시드만 쓴다.
- 워커는 기동 시 스트림 `CONVERSATIONS_STREAM`, `INGESTION_DLQ`를 보장하고, durable pull consumer `ingestion`으로 `helpdesk.events.*.*.*.message_created`만 Fetch한다. 배치 상한 500건, 대기 100ms.
- 플러시는 `account_id`로 묶고, 그룹마다 `set_config('app.current_account_id', …, true)` 후 `INSERT … ON CONFLICT (id) DO NOTHING` 한다. 배치 실패 시 단건으로 폴백하고, 영구 실패는 `helpdesk.dlq.ingestion`에 `{ "error", "raw" }`를 넣은 뒤 원본 ACK.
- `svc-core`는 `helpdesk.rpc.conversations.create` / `transition`을 queue group `svc-core`로 받는다. 생성은 컨택트·인박스링크·`account_sequences` 채번·대화(`unassigned`, `version=1`)를 한 트랜잭션에 넣는다. 전이는 허용표 + `version` CAS이고, 성공 시 `event_outbox`에 `status_changed`를 쓴 뒤 JetStream에 발행한다. P2는 snooze 전이를 거절한다.
- `gateway-web`은 PG에 붙지 않는다. P2 인증은 HMAC 서명 클레임이다. Contact는 `account_id`·`inbox_id`·`source_id`(생성 후 `conversation_id`), User는 `account_id`·`inbox_ids`. `pubsub_token` 컬럼 조회와 짧은 만료 토큰은 P3.
- Client API `POST /public/api/v1/inboxes/{inbox_id}/messages`: 토큰에 대화 ID가 없으면 `helpdesk.rpc.conversations.create`가 성공한 뒤에만 `message_created`와 `helpdesk.realtime.<account_id>.<conversation_id>.updated`를 발행한다. RPC 실패 시 둘 다 없다. 기존 대화는 create를 건너뛴다.
- Application API `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`: User 토큰의 `inbox_ids`에 요청 `inbox_id`가 있을 때만 outgoing `message_created`. 대화 행 조회가 없으므로 바디에 `inbox_id`·`contact_id`·`contact_inbox_id`가 필요하다.
- WS `GET /ws?token=`: Contact는 자기 `conversation_id`만, User는 클레임 `inbox_ids`에 속한 대화만 받는다. 연결 후 `{"type":"ready"}`.

## Commands

저장소 루트 기준.

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend
go test ./...
go run ./cmd/ingestion-worker
go run ./cmd/svc-core
go run ./cmd/gateway-web
```

환경변수: `AURA_MIGRATE_DSN` (슈퍼유저), `AURA_DSN` (`aura_app`), `AURA_NATS_URL`, `AURA_TOKEN_SECRET` (`gateway-web`), `AURA_HTTP_ADDR` (기본 `:8080`).
