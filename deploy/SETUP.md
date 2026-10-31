# SETUP

로컬은 Compose, 클러스터는 Kustomize 베이스다. 빈 매니페스트를 두지 않는다.

## 로컬 (파일럿 테넌트)

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
cd backend && go test ./... && go run ./cmd/ingestion-worker

go run ./cmd/svc-core
go run ./cmd/gateway-web
go run ./cmd/gateway-email
go run ./cmd/gateway-kakao
go run ./cmd/svc-sla-routing
go run ./cmd/svc-automation
go run ./cmd/event-archive
cd ../svc-ai-agent && python -m aura_ai
cd ../frontend && npm run dev
```

`gateway-email` SMTP 문서상 기본 포트는 `25`다. 에릭은 `:2050`에서 실행한다. 포트는 `AURA_SMTP_ADDR`로 바꾼다.

compose `seed`와 k8s Job `seed`는 같은 `aura/seed:main`이다. 기본 로그인은 [compose/README.md](compose/README.md).

Platform API로 추가 파일럿 계정:

```sh
curl -H "Authorization: Bearer $AURA_PLATFORM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"pilot","locale":"ko","user":{"name":"Ada","email":"ada@pilot.test","password":"s3cret"}}' \
  http://127.0.0.1:8080/platform/api/v1/accounts
```

LLM 키가 비면 `svc-ai-agent`는 결정적 stub이다. 실모델은 `AURA_LLM_API_KEY`와 `AURA_LLM_BASE_URL`.

필수 시크릿: `AURA_TOKEN_SECRET`, `AURA_PLATFORM_TOKEN`. 선택: `AURA_LLM_API_KEY`, `AURA_KAKAO_API_URL`, `AURA_KAKAO_API_KEY`.

## 이미지

저장소 루트에서:

```sh
docker build -t aura/svc-core:main --build-arg CMD=svc-core backend
docker build -t aura/ingestion-worker:main --build-arg CMD=ingestion-worker backend
docker build -t aura/gateway-web:main --build-arg CMD=gateway-web --target gateway-web --build-context widget=packages/widget-sdk -f backend/Dockerfile backend
docker build -t aura/gateway-email:main --build-arg CMD=gateway-email backend
docker build -t aura/gateway-kakao:main --build-arg CMD=gateway-kakao backend
docker build -t aura/svc-sla-routing:main --build-arg CMD=svc-sla-routing backend
docker build -t aura/svc-automation:main --build-arg CMD=svc-automation backend
docker build -t aura/event-archive:main --build-arg CMD=event-archive backend
docker build -t aura/seed:main --build-arg CMD=seed backend
docker build -t aura/svc-ai-agent:main svc-ai-agent
docker build -t aura/frontend:main frontend
```

## 클러스터

베이스에서 외부 인입은 NodePort다. `frontend` HTTP `30080`→`:80`, `gateway-email` SMTP `30025`→`:25`, `gateway-kakao` HTTP `30081`→`:8081`. nginx는 `/api`·`/auth`·`/ws`를 `gateway-web`으로 프록시한다. `gateway-web`과 워커는 ClusterIP. TLS/HTTPS는 패키지가 종료하지 않는다. 고객 앞단 L4/L7 로드밸런서 또는 Ingress에서 종료한다.

로컬 접속:

- 상담원 SPA: `http://localhost:30080`
- 카카오 웹훅: `POST http://localhost:30081/cstalk/message`
- SMTP: `localhost:30025`

PostgreSQL(pgvector)·NATS JetStream·SeaweedFS는 클러스터 밖 또는 별도 차트다. `deploy/k8s/base/configmap.yaml` DSN을 맞춘 뒤:

```sh
kubectl create secret generic aura-secrets -n aura \
  --from-literal=AURA_TOKEN_SECRET=change-me \
  --from-literal=AURA_PLATFORM_TOKEN=change-me \
  --from-literal=AURA_LLM_API_KEY= \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k deploy/k8s/base
```

고객 파기: administrator `POST /api/v1/accounts/{account_id}/contacts/{contact_id}/purge` 가 PG 식별자·본문·CSAT·도구 JSON을 익명화하고 그 컨택트 대화 JetStream subject와 `archive/{account_id}/{conversation_id}/` JSONL prefix를 지운다.
