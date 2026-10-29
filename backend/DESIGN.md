# backend

`svc-ingestion-worker`와 PostgreSQL 마이그레이션. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md).

## 내부 설계

- 런타임 롤은 `aura_app` (`NOBYPASSRLS`). 슈퍼유저 DSN은 마이그레이션·시드만 쓴다.
- 워커는 기동 시 스트림 `CONVERSATIONS_STREAM`, `INGESTION_DLQ`를 보장하고, durable pull consumer `ingestion`으로 `helpdesk.events.*.*.*.message_created`만 Fetch한다. 배치 상한 500건, 대기 100ms.
- 플러시는 `account_id`로 묶고, 그룹마다 `set_config('app.current_account_id', …, true)` 후 `INSERT … ON CONFLICT (id) DO NOTHING` 한다. 배치 실패 시 단건으로 폴백하고, 영구 실패는 `helpdesk.dlq.ingestion`에 `{ "error", "raw" }`를 넣은 뒤 원본 ACK.
- P1은 `message_created`만 적재한다. `contacts`/`conversations`는 테스트 픽스처(또는 이후 `svc-core`)가 만든다.

## Commands

저장소 루트 기준.

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend
go test ./...
go run ./cmd/ingestion-worker
```

환경변수: `AURA_MIGRATE_DSN` (슈퍼유저), `AURA_DSN` (`aura_app`), `AURA_NATS_URL`.
