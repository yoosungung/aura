# virtual-client

가상고객 실행 하네스. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md), 시나리오 기준은 [docs/가상고객_테스트.md](../docs/가상고객_테스트.md). Aura 게이트웨이·AI·NATS를 바꾸지 않는다. in-process MCP stub은 그대로 두고, 테넌트 `mcp_servers.url`만 이 프로세스의 모의 MCP를 가리킨다.

## 내부 설계

- LangWatch Scenario는 채널을 모른다. `AgentAdapter.call()`이 시뮬레이터 발화를 `gateway-web` / `gateway-kakao` / `gateway-email` 규격으로 넣고, **같은 채널 아웃바운드**에서 텍스트를 읽어 반환한다. 인입 ACK는 회신이 아니다. 상담원 Application API로 고객 답을 읽지 않는다.
- 웹: `POST /public/api/v1/inboxes/{id}/auth` → `POST .../messages` → `GET .../messages`. `sender_type`이 `AgentBot`/`User`이고 `kind=tool_approval` JSON이 아닌 본문만 회신이다. Client API에 컨택트 생성이 없어 bootstrap이 `contacts`+`contact_inboxes.pubsub_token`을 DSN으로 한 건 넣는다.
- 카카오: `POST :8081/cstalk/message`, ACK `A000`. 회신은 가짜 허브 `POST /cstalk/plain`. `AURA_KAKAO_API_URL=http://127.0.0.1:18081`. `session_live=false`면 허브가 비고, 그때 상담원 API로 읽지 않는다.
- 이메일: SMTP `127.0.0.1:2050` DATA. 회신은 Mailpit `GET /api/v1/messages`에서 `To=가상고객`. 다음 턴 `In-Reply-To`. Mailpit은 compose에 없다.
- 모의 MCP는 FastMCP Streamable HTTP(`:18082/mcp`). `ScenarioSpec.fixture`가 `lookup_order` / `lookup_shipping` / `refund` JSON이다. `svc-ai-agent`는 `ops_tools`를 프로세스에 캐시하므로 MCP 등록 뒤 에이전트를 재시작한다.
- Counselor는 admin 세션으로 `content_type=form` 승인 카드만 `POST .../tools/{execution_id}/approve` 한다. Judge는 이 경로의 텍스트를 쓰지 않는다.

## Commands

저장소 루트 기준. 단위 테스트는 게이트웨이 없이 돈다. 시나리오 실행은 로컬 풀스택 + 실 LLM이 필요하다. 시뮬레이터·Judge는 `AURA_LLM_API_KEY`(또는 `OPENAI_API_KEY`)가 없으면 바로 종료한다. 키가 비어 있으면 `run.sh`가 `aura-secrets`/`aura-config`를 읽는다. `host.docker.internal`은 호스트에서 `127.0.0.1`로 바꾼다. CI는 이 패키지를 돌리지 않는다.

```sh
python3.12 -m venv virtual-client/.venv
. virtual-client/.venv/bin/activate
pip install -e '.[dev]'
python -m pytest

# 기본은 클러스터 NodePort. 웹 http://127.0.0.1:30080, 카카오 :30081, SMTP :30025.
# run.sh가 채널에 맞는 게이트웨이가 응답하는지 확인한 뒤 실행한다. --help는 건너뛴다.
# Docker Desktop에서 localhost가 닫혀 있으면 deploy/k8s/nodeport-proxy.sh 를 띄운 뒤 다시 친다.
# POST /public 405면 프론트 이미지에 location /public/이 없다. nginx.conf 반영 후 kind에 import.
# compose 재시작 뒤 sign_in 401이면 deploy/k8s/compose-endpoints.sh 로 PG/NATS Endpoints를 맞춘다.
# 카카오 아웃바운드: 클러스터 AURA_KAKAO_API_URL이 호스트 허브(18081)를 가리켜야 한다.
# go run 로컬 게이트웨이는 --base/--kakao-base/--smtp-port 로 덮어쓴다.
./virtual-client/run.sh --channel web --scenario lost-package --max-turns 8
./virtual-client/run.sh --channel all --scenario all
./virtual-client/run.sh --base http://127.0.0.1:8080 --kakao-base http://127.0.0.1:8081 --smtp-port 2050
```

환경변수: `AURA_GATEWAY_URL`(기본 `http://127.0.0.1:30080`), `AURA_KAKAO_URL`(기본 `http://127.0.0.1:30081`), `AURA_SMTP_HOST`/`AURA_SMTP_PORT`(기본 `30025`), `AURA_DSN`(웹 시드), `AURA_LLM_API_KEY` / `AURA_LLM_MODEL` / `AURA_LLM_BASE_URL`(시뮬레이터·Judge). `AURA_LLM_MODEL`에 `/`가 없으면 LiteLLM용으로 `openai/`를 붙인다. 모델 이름에 `gemma`가 있으면 Judge·시뮬레이터가 Ollama `extra_body.think=false` / `reasoning_effort=none`을 넣어 thinking을 끈다. Mailpit API는 `http://127.0.0.1:8025`.
