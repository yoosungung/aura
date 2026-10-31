# Aura

옴니채널 헬프데스크와 고객 Ego-Graph AI 에이전트를 한 PostgreSQL·NATS 백본 위에 둔 CRM이다. 상담원은 Rail + 3-Pane 워크스페이스에서 웹·이메일·카카오 티켓을 처리하고, AI는 저위험 응답을 자동으로 보내거나 고위험 액션을 승인 카드로 넘긴다.

이 문서는 **설치·운영·배포**용이다. 소스 수정·테스트·기여는 [README.developer.md](README.developer.md). 런북 정본은 [deploy/SETUP.md](deploy/SETUP.md).

## 의존성

앱 프로세스 밖에 PostgreSQL 16+pgvector, NATS JetStream, SeaweedFS가 있어야 한다. 로컬은 Compose, 클러스터는 외부 또는 별도 차트다.

필수 시크릿: `AURA_TOKEN_SECRET`, `AURA_PLATFORM_TOKEN`. 선택: `AURA_LLM_API_KEY`, `AURA_KAKAO_API_URL`, `AURA_KAKAO_API_KEY`. LLM 키가 비면 `svc-ai-agent`는 결정적 stub이다.

## 로컬 백본

```sh
docker compose -f deploy/compose/docker-compose.yml up -d
```

포트: Postgres `5432`, NATS `4222`, SeaweedFS 필러 `8888`. 상세는 [deploy/compose/README.md](deploy/compose/README.md).

## 이미지와 클러스터

이미지 빌드와 `kubectl apply -k deploy/k8s/base`는 [deploy/SETUP.md](deploy/SETUP.md). 클러스터 로컬 사용법은 [deploy/k8s/README.md](deploy/k8s/README.md). ConfigMap DSN(`postgres` / `nats` / `seaweedfs-filer`)을 실제 백본에 맞춘 뒤 `aura-secrets`를 만들고 베이스를 적용한다.

클러스터 안은 HTTP다. 로컬 베이스 NodePort: `frontend` `30080`, `gateway-email` SMTP `30025`, `gateway-kakao` `30081`. `gateway-web`은 ClusterIP. TLS는 고객 인그레스 또는 L4/L7 로드밸런서에서 종료한다. 상세는 [deploy/SETUP.md](deploy/SETUP.md) 클러스터.

```sh
# http://localhost:30080
# smtp://localhost:30025
# http://localhost:30081
kubectl get svc -n aura frontend gateway-email gateway-kakao
```

로컬 compose 기본 로그인은 [deploy/compose/README.md](deploy/compose/README.md). 추가 테넌트는 Platform API(`AURA_PLATFORM_TOKEN`), 예는 [deploy/SETUP.md](deploy/SETUP.md).
