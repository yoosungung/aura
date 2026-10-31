# svc-ai-agent

Python AI 워커. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). PG INSERT/UPDATE/DELETE를 하지 않는다. Ego-Graph·embeddings는 SELECT만 하고, 메시지·도구감사·온톨로지·임베딩 쓰기는 NATS 이벤트다.

## 내부 설계

- JetStream WorkQueue `helpdesk.tasks.ai.reasoning` / `ai.execute` / `ontology.extract` / `ai.embed` 를 durable `svc-ai-reasoning` / `svc-ai-execute` / `svc-ai-ontology` / `svc-ai-embed` 로 소비한다.
- 추론은 LangChain `create_agent`다. 모델은 OpenAI 호환(`AURA_LLM_BASE_URL`/`AURA_LLM_MODEL`). 고객 메시지를 임베딩한 뒤 published article을 현재 `model`/`version` cosine top-5로 읽고 Ego-Graph와 함께 넣는다. 검색 트랜잭션에서 `SET LOCAL hnsw.ef_search = 40`, `hnsw.iterative_scan = relaxed_order`. `AURA_LLM_API_KEY`가 비면 결정적 stub 모델(환불·취소 키워드 → 고위험 카드, 그 외 → `send_status`). 미들웨어: Ego/RAG 주입, Agent Skills `load_skill`, `ToolCallLimitMiddleware(run_limit=8)`, `ModelRetryMiddleware`, AuraHITL(고위험 MCP는 승인 카드만, LangGraph checkpointer 없음). 동일 (tool, args) 반복은 중단.
- 네이티브 도구는 `send_status`(outgoing `message_created`와 `helpdesk.tasks.outbound.<channel>`, web은 realtime만). 운영계 도구(`lookup_order` / `lookup_shipping` / `refund` / `cancel_subscription` / `change_plan` 등)는 테넌트 `mcp_servers` MCP. 서버가 없으면 in-process FastMCP stub. 고위험은 `tool_execution`(requires_approval) + `content_type=form` 승인 카드만 내고 MCP는 치지 않는다.
- Agent Skills는 `skills/*/SKILL.md` 메타를 시스템 프롬프트에 넣고, `load_skill`이 본문을 읽는다. 같은 `name`의 `agent_skills` 행이 있으면 last-wins.
- 승인 후 `ai.execute`가 운영계 MCP를 호출하고 결과를 고객에게 보낸다. `auth_header`는 이벤트에 넣지 않는다.
- resolved extract는 대화 메시지를 읽어 노드/엣지 JSON을 만들고 `ontology_extracted`를 발행한다. Customer 노드는 `external_ref_id=contacts.id`로 upsert.
- article embed는 본문 임베딩을 만들어 `embedding_upsert`를 발행한다. 차원이 1536이 아니면 드롭.
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

환경변수: `AURA_DSN`, `AURA_NATS_URL`, `AURA_LLM_BASE_URL`, `AURA_LLM_API_KEY`, `AURA_LLM_MODEL`, `AURA_EMBEDDING_MODEL`.
