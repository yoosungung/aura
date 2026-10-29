# compose

로컬 백본: PostgreSQL 16 + pgvector, NATS JetStream. MinIO는 P3.

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
```

- Postgres `localhost:5432` — 슈퍼유저 `aura`/`aura`, DB `aura`. 런타임 롤 `aura_app`/`aura_app`은 마이그레이션이 만든다.
- NATS `localhost:4222`, 모니터링 `8222`. 스트림은 워커가 기동 시 생성한다.
