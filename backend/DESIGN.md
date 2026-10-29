# backend

`svc-ingestion-worker`, `svc-core`, PostgreSQL 마이그레이션. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md).

## 내부 설계

- 런타임 롤은 `aura_app` (`NOBYPASSRLS`). 슈퍼유저 DSN은 마이그레이션·시드만 쓴다.
- 워커는 기동 시 스트림 `CONVERSATIONS_STREAM`, `INGESTION_DLQ`를 보장하고, durable pull consumer `ingestion`으로 `helpdesk.events.*.*.*.message_created`만 Fetch한다. 배치 상한 500건, 대기 100ms.
- 플러시는 `account_id`로 묶고, 그룹마다 `set_config('app.current_account_id', …, true)` 후 `INSERT … ON CONFLICT (id) DO NOTHING` 한다. 배치 실패 시 단건으로 폴백하고, 영구 실패는 `helpdesk.dlq.ingestion`에 `{ "error", "raw" }`를 넣은 뒤 원본 ACK.
- `svc-core`는 `helpdesk.rpc.conversations.create` / `transition`을 queue group `svc-core`로 받는다. 생성은 컨택트·인박스링크·`account_sequences` 채번·대화(`unassigned`, `version=1`)를 한 트랜잭션에 넣는다. 전이는 허용표 + `version` CAS이고, 성공 시 `event_outbox`에 `status_changed`를 쓴 뒤 JetStream에 발행한다. P2는 snooze 전이를 거절한다.

## Commands

저장소 루트 기준.

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend
go test ./...
go run ./cmd/ingestion-worker
go run ./cmd/svc-core
```

환경변수: `AURA_MIGRATE_DSN` (슈퍼유저), `AURA_DSN` (`aura_app`), `AURA_NATS_URL`.
