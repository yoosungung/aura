# k8s

로컬·클러스터에서 Kustomize 베이스를 적용하는 사용법이다. 이미지 빌드·시크릿·런북은 [../SETUP.md](../SETUP.md).

## 전제

Docker Desktop Kubernetes, 또는 `kubectl`이 가리키는 클러스터. 앱 이미지는 클러스터가 pull할 수 있어야 한다. PostgreSQL·NATS·SeaweedFS는 이 디렉터리 밖이다. 로컬은 [../compose](../compose).

## 적용

```sh
kubectl apply -k deploy/k8s/base
```

네임스페이스는 `aura`다. `namespace.yaml`이 만들고, 베이스 리소스는 그 안에 들어간다.

## 시드

`aura/seed:main`(`backend/Dockerfile` `--build-arg CMD=seed`)이 `cmd/seed`를 실행한다. compose `seed` 서비스와 같은 이미지·엔트리포인트다. 베이스 Job `seed`가 `AURA_MIGRATE_DSN`으로 마이그레이션 뒤 기본 로그인을 넣고, 계정이 있으면 건너뛴다. 값은 [../compose/README.md](../compose/README.md). 다시 돌리려면 `kubectl delete job seed -n aura` 후 베이스를 적용한다.

```sh
docker build -t aura/seed:main --build-arg CMD=seed backend
kubectl apply -k deploy/k8s/base
```

## NodePort

패키지는 클러스터 안에서 HTTP를 연다. 프론트 컨테이너·Service 포트는 `80`. TLS는 고객 앞단 인그레스 또는 L4/L7 로드밸런서에서 종료한다.

| Service | 용도 | nodePort |
|---------|------|----------|
| `frontend` | 상담원 SPA | `30080` → `:80` |
| `gateway-kakao` | 카카오 웹훅 | `30081` → `:8081` |
| `gateway-email` | SMTP | `30025` → `:25` |

`gateway-web`과 워커는 ClusterIP. 로컬에서 SPA는 `http://localhost:30080`.

## 위젯 SDK

위젯 소스(`widget.html` · `widget.js` 등)는 서버가 서빙하지 않는다. 고객사에는 압축 아카이브로 배포한다.
