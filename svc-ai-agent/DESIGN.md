# svc-ai-agent

Python AI 워커. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). PG INSERT/UPDATE/DELETE를 하지 않는다. Ego-Graph·embeddings는 SELECT만 하고, 메시지·도구감사·온톨로지·임베딩 쓰기는 NATS 이벤트다.

## 내부 설계

- JetStream WorkQueue `helpdesk.tasks.ai.reasoning` / `ai.execute` / `ontology.extract` / `ai.embed` 를 durable `svc-ai-reasoning` / `svc-ai-execute` / `svc-ai-ontology` / `svc-ai-embed` 로 소비한다. Go가 만든 `TASKS_STREAM` durable에 `pull_subscribe_bind`만 하고, 핸들러는 워커 스레드에서 돌려 NATS 이벤트 루프를 막지 않는다. 구독은 모두 bind한 뒤에 fetch를 시작한다. 로컬 디버그(`AURA_JS_DRAIN_PENDING`)는 시작 시 미ACK 백로그를 ACK만 하고 버린다. 파드 기동에는 이 변수를 두지 않는다.
- 추론은 LangChain `create_agent`다. 모델은 OpenAI 호환(`AURA_LLM_BASE_URL`/`AURA_LLM_MODEL`). 고객 메시지를 임베딩한 뒤 published article을 현재 `AURA_EMBEDDING_MODEL`/`version`·같은 차원 cosine top-5로 읽고 Ego-Graph와 함께 넣는다. 검색 트랜잭션에서 `SET LOCAL hnsw.ef_search = 40`, `hnsw.iterative_scan = relaxed_order`. 질의 차원이 비거나 4000을 넘으면 RAG는 빈 결과다. `AURA_LLM_API_KEY`가 비면 결정적 stub 모델(환불·취소 키워드 → 고위험 카드, 그 외 → `send_status`). 미들웨어: Ego/RAG 주입, Agent Skills `load_skill`, `ToolCallLimitMiddleware(run_limit=8)`, `ModelRetryMiddleware`, AuraHITL(고위험 MCP는 승인 카드만, LangGraph checkpointer 없음). 동일 (tool, args) 반복은 중단.
- 네이티브 도구는 `send_status`(outgoing `message_created`와 `helpdesk.tasks.outbound.<channel>`, web은 realtime만). 운영계 도구(`lookup_order` / `lookup_shipping` / `refund` / `cancel_subscription` / `change_plan` 등)는 테넌트 `mcp_servers` MCP. 서버가 없으면 in-process FastMCP stub. URL이 바뀌면 다음 턴에 다시 붙고, 연결 실패면 그 턴만 stub이며 프로세스는 유지한다. 고위험은 `tool_execution`(requires_approval) + `content_type=form` 승인 카드만 내고 MCP는 치지 않는다.
- Staff available은 PG SELECT만: 인박스 `business_hours`(`OpenNow`와 동일)와 온라인 멤버 수. 가용하면 form `private=false`. 비가용이면 form `private=true` + 고객 공개 문구「요청을 접수했습니다. 상담원이 확인 후 처리합니다.」outbound. FSM은 건드리지 않는다.
- Agent Skills는 `skills/*/SKILL.md` 메타를 시스템 프롬프트에 넣고, `load_skill`이 본문을 읽는다. 같은 `name`의 `agent_skills` 행이 있으면 last-wins.
- 승인 후 `ai.execute`가 운영계 MCP를 호출하고 결과를 고객에게 보낸다. `auth_header`는 이벤트에 넣지 않는다.
- resolved extract는 대화 메시지를 읽어 노드/엣지 JSON을 만들고 `ontology_extracted`를 발행한다. Customer 노드는 `external_ref_id=contacts.id`로 upsert.
- article embed는 본문 임베딩을 만들어 `embedding_upsert`를 발행한다. 길이는 모델 차원 그대로(1..4000)이고, `model`은 `AURA_EMBEDDING_MODEL`이다. 비거나 한도를 넘으면 드롭.
- 채널별 token-bucket + 서킷브레이커는 아웃바운드 발행 직전에 적용한다.
- Envelope `hop_count`는 태스크 값 + 1, `causation_id`는 `trigger_message_id`, `trace_id`는 태스크 값을 따른다. `hop_count > 5`면 추론을 건너뛴다.

## Commands

저장소 루트 기준.

```sh
python3.12 -m venv svc-ai-agent/.venv
. svc-ai-agent/.venv/bin/activate
pip install -e '.[dev]'
# langchain[mcp] 는 프로젝트 의존성에 포함된다.
python -m pytest
python -m aura_ai
```

클러스터 파드와 WorkQueue durable을 같이 쓰지 않는다. Cursor/VS Code는 `.vscode` launch `svc-ai-agent: local debug`(시작 전 파드 0, 종료 후 1, `AURA_JS_DRAIN_PENDING`)를 **먼저** 띄운 뒤 `Virtual Client`. 모의 MCP(`:18082`)가 아직 없어도 에이전트는 stub으로 대기하고, bootstrap이 URL을 등록하면 재시작 없이 다음 턴에 붙는다. 호스트는 OrbStack NodePort NATS `:30422`·PG `:30432`, LLM은 `127.0.0.1:11434`.

환경변수: `AURA_DSN`(호스트 디버그 `127.0.0.1:30432`), `AURA_NATS_URL`(비면 `nats://127.0.0.1:30422`), `AURA_LLM_BASE_URL`, `AURA_LLM_API_KEY`, `AURA_LLM_MODEL`, `AURA_EMBEDDING_MODEL`, `AURA_JS_DRAIN_PENDING`(로컬 디버그 백로그 ACK).
