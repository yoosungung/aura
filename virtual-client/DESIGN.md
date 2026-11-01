# virtual-client

가상고객 실행 하네스. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md), 시나리오 기준은 [docs/가상고객_테스트.md](../docs/가상고객_테스트.md). Aura 게이트웨이·AI·NATS를 바꾸지 않는다. in-process MCP stub은 그대로 두고, 테넌트 `mcp_servers.url`만 이 프로세스의 모의 MCP를 가리킨다.

## 내부 설계

- LangWatch Scenario는 채널을 모른다. `AgentAdapter.call()`이 시뮬레이터 발화를 `gateway-web` / `gateway-kakao` / `gateway-email` 규격으로 넣고, **같은 채널 아웃바운드**에서 텍스트를 읽어 반환한다. 인입 ACK는 회신이 아니다. 상담원 Application API로 고객 답을 읽지 않는다.
- 웹: `POST /public/api/v1/inboxes/{id}/auth` → `POST .../messages` → `GET .../messages`. `sender_type`이 `AgentBot`/`User`이고 `kind=tool_approval` JSON이 아닌 본문만 회신이다. Client API에 컨택트 생성이 없어 bootstrap이 `contacts`+`contact_inboxes.pubsub_token`을 DSN으로 한 건 넣는다.
- 카카오: `POST :8081/cstalk/message`, ACK `A000`. 회신은 가짜 허브 `POST /cstalk/plain`. `AURA_KAKAO_API_URL=http://127.0.0.1:18081`. `session_live=false`면 허브가 비고, 그때 상담원 API로 읽지 않는다.
- 이메일: SMTP `127.0.0.1:2050` DATA. 회신은 Mailpit `GET /api/v1/messages`에서 `To=가상고객`. 다음 턴 `In-Reply-To`. Mailpit은 compose에 없다.
- 모의 MCP는 FastMCP Streamable HTTP(`:18082/mcp`). 시나리오 픽스처가 `lookup_order` / `lookup_shipping` / `refund` JSON을 바꾼다. `svc-ai-agent`는 `ops_tools`를 프로세스에 캐시하므로 MCP 등록 뒤 에이전트를 재시작한다.
- Counselor는 admin 세션으로 `content_type=form` 승인 카드만 `POST .../tools/{execution_id}/approve` 한다. Judge는 이 경로의 텍스트를 쓰지 않는다.

## Commands

저장소 루트 기준. 단위 테스트는 게이트웨이 없이 돈다. 시나리오 실행은 로컬 풀스택 + 실 LLM 키가 필요하다. CI는 이 패키지를 돌리지 않는다.

```sh
python3.12 -m venv virtual-client/.venv
. virtual-client/.venv/bin/activate
pip install -e '.[dev]'
python -m pytest

# 풀스택 전제: compose, gateway-*, svc-core, ingestion, svc-ai-agent(실 키).
# 카카오: AURA_KAKAO_API_URL=http://127.0.0.1:18081
# 이메일: AURA_SMTP_ADDR=:2050, Mailpit이 AURA_SMTP_RELAY를 받는다.
mailpit --smtp 0.0.0.0:2525 --listen 0.0.0.0:8025

# MCP 등록 후 svc-ai-agent를 재시작한다.
python -m virtual_client --channel web --scenario lost-package --max-turns 8
python -m virtual_client --channel all --scenario all
```

환경변수: `AURA_HTTP_ADDR`(기본 `http://127.0.0.1:8080`), `AURA_KAKAO_ADDR`, `AURA_SMTP_ADDR`/`AURA_SMTP_HOST`+포트, `AURA_DSN`(웹 시드), `AURA_LLM_API_KEY` / `AURA_LLM_MODEL`(시뮬레이터·Judge). Mailpit API는 `http://127.0.0.1:8025`.
