# compose

로컬 백본: PostgreSQL 16 + pgvector, NATS JetStream, SeaweedFS(마스터·볼륨·필러).

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
```

- Postgres `localhost:5432` — 슈퍼유저 `aura`/`aura`, DB `aura`. 런타임 롤 `aura_app`/`aura_app`은 마이그레이션이 만든다.
- NATS `localhost:4222`, 모니터링 `8222`. 스트림은 워커가 기동 시 생성한다.
- SeaweedFS 마스터 `9333`, 필러 `8888`. 볼륨 서버는 컴포즈 네트워크만. 객체 경로는 `{account_id}/`.
