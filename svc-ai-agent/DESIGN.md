# svc-ai-agent

Python AI 워커. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). PG INSERT/UPDATE/DELETE를 하지 않는다. Ego-Graph·embeddings는 SELECT만 하고, 메시지·도구감사·온톨로지·임베딩 쓰기는 NATS 이벤트다.

## Flow

JetStream WorkQueue 4종을 소비한다. 고위험은 `reasoning`에서 승인 카드만 내고 MCP는 `ai.execute`에서 친다.

```mermaid
flowchart TD
  accTitle: svc-ai-agent task flow
  accDescr: Four WorkQueue subjects enter the worker. Reasoning may skip on hop limit, load Ego/RAG/skills/MCP, run create_agent, then auto-reply or emit an approval card gated by staff availability. Execute calls ops MCP. Ontology extract and article embed publish events for ingestion.

  subgraph Triggers["인입 트리거"]
    GW["gateway-* 고객 메시지"]
    CORE_OK["svc-core 승인"]
    CORE_RES["svc-core resolved"]
    CORE_ART["article 게시/갱신"]
  end

  GW --> T_REASON["WorkQueue<br/>helpdesk.tasks.ai.reasoning"]
  CORE_OK --> T_EXEC["WorkQueue<br/>helpdesk.tasks.ai.execute"]
  CORE_RES --> T_ONT["WorkQueue<br/>helpdesk.tasks.ontology.extract"]
  CORE_ART --> T_EMBED["WorkQueue<br/>helpdesk.tasks.ai.embed"]

  subgraph Worker["svc-ai-agent"]
    T_REASON --> HOP{"hop_count > 5?"}
    HOP -->|yes| SKIP1["skip"]
    HOP -->|no|     CTX["SELECT: L3 persona + 활성 L2<br/>RAG · skills · mcp_servers"]
    CTX --> EMB["고객 메시지 embed"]
    EMB --> RAG["HNSW cosine top-5 article"]
    RAG --> AGENT["LangChain create_agent<br/>memory_drill_* + send_status + MCP"]
    AGENT --> LOOP["ReAct: model → tool_calls"]
    LOOP --> MEM{"memory_drill_*?"}
    MEM -->|yes| DRILL["링크 traverse SELECT<br/>L3↔L2↔L1↔L0"]
    DRILL --> LOOP
    MEM -->|no| RISK{"고위험 도구?"}
    RISK -->|yes| STAFF{"staff available?<br/>hours + online"}
    STAFF -->|yes| CARD["tool_execution requires_approval<br/>+ form private=false"]
    STAFF -->|no| DEFER["form private=true<br/>+ 고객 공개 접수 문구 outbound"]
    RISK -->|no| LOW["저위험 MCP / send_status 즉시 실행"]
    LOW --> OUT["token-bucket + circuit<br/>message_created ± outbound.*"]
    CARD --> WAIT["상담원 승인 대기"]

    T_EXEC --> MCP["운영계 MCP 호출<br/>auth_header는 이벤트에 미포함"]
    MCP --> OUT2["tool_execution success<br/>+ 고객 회신 outbound"]

    T_ONT --> READ_L0["public messages SELECT (L0)"]
    READ_L0 --> EXT["atoms + Scenario + HAS_SCENARIO<br/>CONTAINS_ATOM + source_message_ids"]
    EXT --> ONT_EVT["ontology_extracted 발행"]
    EXT --> EMB_N["ontology_node embedding_upsert"]

    T_EMBED --> READ_ART["article 본문 SELECT"]
    READ_ART --> VEC["embedding 생성"]
    VEC --> DIM{"dim 1..4000?"}
    DIM -->|no| SKIP2["drop"]
    DIM -->|yes| EMB_EVT["embedding_upsert 발행"]
  end

  WAIT -.-> CORE_OK
  OUT --> INGEST["ingestion / realtime"]
  OUT2 --> INGEST
  ONT_EVT --> INGEST
  EMB_EVT --> INGEST
  DEFER --> INGEST
```

## 내부 설계

- JetStream 태스크 진입은 `handlers.Handler`(`handle_reasoning` 등), LangChain 루프는 `agent.Agent.run` → Decision이다. `LLM`은 `complete` 어댑터만 제공하고 에이전트를 감싸지 않는다. PG 바인딩은 `ego.bind_handler`.
- JetStream WorkQueue `helpdesk.tasks.ai.reasoning` / `ai.execute` / `ontology.extract` / `ai.embed` 를 durable `svc-ai-reasoning` / `svc-ai-execute` / `svc-ai-ontology` / `svc-ai-embed` 로 소비한다. Go가 만든 `TASKS_STREAM` durable에 `pull_subscribe_bind`만 하고, 핸들러는 native async(`await handle_*`)다. LLM(`httpx.AsyncClient`)·MCP(`ainvoke`)·PG(`AsyncConnectionPool`)가 같은 이벤트 루프에서 돌아간다. 동시성은 `asyncio.Semaphore`(`AURA_AI_CONCURRENCY`, 기본 4)로 제한하고, 메시지별 `NATSBus` 버퍼는 `contextvars`로 격리한다. 구독은 모두 bind한 뒤에 fetch를 시작한다. 로컬 디버그(`AURA_JS_DRAIN_DEBUGING`)는 시작 시 미ACK 백로그를 ACK만 하고 버린다. 파드 기동에는 이 변수를 두지 않는다.
- 추론은 LangChain `create_agent`다. 모델은 OpenAI 호환(`AURA_LLM_BASE_URL`/`AURA_LLM_MODEL`). 부트스트랩은 L3(Customer `properties.summary` + Preference/PainPoint 요약)와 활성 L2 Scenario 1블록만 넣는다. article RAG는 별도. L1/L0는 `memory_drill_down`/`memory_drill_up`/`memory_search`로만. `AURA_LLM_API_KEY`가 비면 결정적 stub. 미들웨어: Skills, `ToolCallLimitMiddleware(run_limit=8)`, `ModelRetryMiddleware`, AuraHITL. checkpointer 없음.
- 네이티브 도구: `send_status`, `memory_drill_down`/`memory_drill_up`/`memory_search`(링크 traverse·SELECT only). 운영계 MCP·고위험 승인 카드는 P8과 동일.
- Staff available은 PG SELECT만: 인박스 `business_hours`(`OpenNow`와 동일)와 온라인 멤버 수. 가용하면 form `private=false`. 비가용이면 form `private=true` + 고객 공개 문구「요청을 접수했습니다. 상담원이 확인 후 처리합니다.」outbound. FSM은 건드리지 않는다.
- Agent Skills는 `skills/*/SKILL.md` 메타를 시스템 프롬프트에 넣고, `load_skill`이 본문을 읽는다. 같은 `name`의 `agent_skills` 행이 있으면 last-wins.
- 승인 후 `ai.execute`가 운영계 MCP를 호출하고 결과를 고객에게 보낸다. `auth_header`는 이벤트에 넣지 않는다.
- resolved extract는 public L0 메시지를 읽어 atom(`source_message_ids` 필수)·Scenario·`CONTAINS_ATOM`·`HAS_SCENARIO`·Customer `summary`를 만들고 `ontology_extracted`를 발행한다. atom/Scenario에 대해 `embedding_upsert(owner_type=ontology_node)`도 낸다. 메시지가 너무 짧으면 skip.
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

클러스터 파드와 WorkQueue durable을 같이 쓰지 않는다. Cursor/VS Code는 `.vscode` launch `svc-ai-agent: local debug`(시작 전 파드 0, 종료 후 1, `AURA_JS_DRAIN_DEBUGING`)를 **먼저** 띄운 뒤 `Virtual Client`. 모의 MCP(`:18082`)가 아직 없어도 에이전트는 stub으로 대기하고, bootstrap이 URL을 등록하면 재시작 없이 다음 턴에 붙는다. 호스트는 OrbStack NodePort NATS `:30422`·PG `:30432`, LLM은 `127.0.0.1:11434`.

환경변수: `AURA_DSN`(호스트 디버그 `127.0.0.1:30432`), `AURA_NATS_URL`(비면 `nats://127.0.0.1:30422`), `AURA_LLM_BASE_URL`, `AURA_LLM_API_KEY`, `AURA_LLM_MODEL`, `AURA_EMBEDDING_MODEL`, `AURA_AI_CONCURRENCY`(기본 4), `AURA_JS_DRAIN_DEBUGING`(로컬 디버그 백로그 ACK).
