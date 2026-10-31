# compose

로컬 백본: PostgreSQL 16 + pgvector, NATS JetStream, SeaweedFS(마스터·볼륨·필러).

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
```

- Postgres `localhost:5432` — 슈퍼유저 `aura`/`aura`, DB `aura`. 런타임 롤 `aura_app`/`aura_app`은 마이그레이션이 만든다.
- NATS `localhost:4222`, 모니터링 `8222`. 스트림은 워커가 기동 시 생성한다.
- SeaweedFS 마스터 `9333`, 필러 `8888`. 볼륨 서버는 컴포즈 네트워크만. 객체 경로는 `{account_id}/`.

`postgres`가 healthy이면 `seed`가 마이그레이션을 적용한 뒤 기본 로그인을 한 번 넣는다. 이미 있으면 건너뛴다. 이미지 `aura/seed:main`(`backend/Dockerfile` `CMD=seed`)이고, 클러스터 Job `seed`와 같은 엔트리포인트다. 클러스터 적용은 [../k8s/README.md](../k8s/README.md).

- 이메일: `admin@example.com`
- 비밀번호: `admin1234`
