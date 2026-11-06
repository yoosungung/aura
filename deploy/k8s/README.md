# k8s

로컬·클러스터에서 Kustomize를 적용하는 사용법이다. 클러스터 기본은 GitHub Packages(`ghcr.io/yoosungung/aura/*:current`). 이미지 빌드·CD·시크릿·런북은 [../SETUP.md](../SETUP.md).

## 전제

Docker Desktop Kubernetes, OrbStack, 또는 `kubectl`이 가리키는 클러스터. 앱 이미지는 클러스터가 pull할 수 있어야 한다. OrbStack은 `docker build` 이미지를 클러스터가 그대로 본다. PostgreSQL(pgvector)·NATS JetStream·SeaweedFS는 베이스 StatefulSet이다. 이미지는 `pgvector/pgvector:0.8.7-pg16`, `nats:2.15-alpine`(`-js` 파일 스토어), `chrislusf/seaweedfs:4.03`(마스터·볼륨·필러)다. 데이터는 PVC 1Gi. 복제는 1이다.

클러스터 안 주소는 ConfigMap 그대로다. `postgres:5432`, `nats:4222`, `seaweedfs-filer:8888`. 슈퍼유저 `aura`/`aura`, DB `aura`. 런타임 롤 `aura_app`/`aura_app`은 마이그레이션이 만든다.

NodePort: postgres `30432`, NATS 클라이언트 `30422`, NATS 모니터 `30822`, 필러 `30888`. Docker Desktop kind는 이 포트가 macOS `localhost`에 바로 안 열린다. OrbStack은 NodePort가 localhost에 열린다. 호스트 프로세스용 `5432`·`4222`·`8888`은 프록시가 맞춘다. 한 번 붙인다.

```sh
sh deploy/k8s/nodeport-proxy.sh
```

프록시가 호스트에 여는 포트: Postgres `5432`, NATS `4222`, 모니터 `8222`, 필러 `8888`, SPA `30080`, 카카오 `30081`, SMTP `30025`. `svc-core`가 PG에 못 붙으면 `POST /auth/sign_in`이 401로 떨어진다.

## 적용

```sh
kubectl apply -k deploy/k8s/ghcr
```

CD가 올린 GHCR `:current`(릴리즈 `current`, `linux/amd64`·`linux/arm64`)다. 로컬에서 빌드한 `aura/*:main`은 `kubectl apply -k deploy/k8s/base`. 네임스페이스는 `aura`다. `namespace.yaml`이 만들고, 베이스 리소스는 그 안에 들어간다.

노드가 containerd면 `docker build -t aura/<svc>:main`만으로는 파드가 새 레이어를 보지 않는다. 이미지를 노드에 넣은 뒤 재시작한다.

```sh
docker save aura/frontend:main | docker exec -i desktop-control-plane ctr -n k8s.io images import --all-platforms -
kubectl -n aura rollout restart deploy/frontend
```

## 시드

클러스터 Job `seed`는 `ghcr.io/yoosungung/aura/seed:current`다. 로컬 베이스는 `aura/seed:main`(`backend/Dockerfile` `--build-arg CMD=seed`)이다. 엔트리포인트는 같다. Postgres가 받은 뒤 Job이 `AURA_MIGRATE_DSN`으로 마이그레이션하고 기본 로그인을 넣는다. 계정이 있으면 건너뛴다. 다시 돌리려면 `kubectl delete job seed -n aura` 후 오버레이를 적용한다.

```sh
kubectl delete job seed -n aura
kubectl apply -k deploy/k8s/ghcr
```

- 이메일: `admin@example.com`
- 비밀번호: `admin1234`

## NodePort

패키지는 클러스터 안에서 HTTP를 연다. 프론트 컨테이너·Service 포트는 `80`. TLS는 고객 앞단 인그레스 또는 L4/L7 로드밸런서에서 종료한다.

| Service | 용도 | nodePort | 호스트(프록시) |
|---------|------|----------|----------------|
| `frontend` | 상담원 SPA | `30080` → `:80` | `30080` |
| `gateway-kakao` | 카카오 웹훅 | `30081` → `:8081` | `30081` |
| `gateway-email` | SMTP | `30025` → `:25` | `30025` |
| `postgres` | PostgreSQL | `30432` → `:5432` | `5432` |
| `nats` | 클라이언트 | `30422` → `:4222` | `4222` |
| `nats` | 모니터 | `30822` → `:8222` | `8222` |
| `seaweedfs-filer` | 필러 | `30888` → `:8888` | `8888` |

`gateway-web`과 워커는 ClusterIP. 로컬에서 SPA는 `http://localhost:30080`. nginx가 `/api`·`/auth`·`/platform`·`/public`·`/ws`를 `gateway-web`으로 넘긴다.

## 위젯 SDK

위젯 소스(`widget.html` · `widget.js` 등)는 서버가 서빙하지 않는다. 고객사에는 압축 아카이브로 배포한다.
