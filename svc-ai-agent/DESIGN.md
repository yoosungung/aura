# svc-ai-agent

Python AI 워커. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). PG INSERT/UPDATE/DELETE를 하지 않는다. Ego-Graph·embeddings는 SELECT만 하고, 메시지·도구감사·온톨로지·임베딩 쓰기는 NATS 이벤트다.

## 내부 설계

- JetStream WorkQueue `helpdesk.tasks.ai.reasoning` / `ai.execute` / `ontology.extract` / `ai.embed` 를 durable `svc-ai-reasoning` / `svc-ai-execute` / `svc-ai-ontology` / `svc-ai-embed` 로 소비한다.
- 추론은 OpenAI 호환 Chat Completions + native tools다. `AURA_LLM_API_KEY`가 비면 결정적 stub(환불·취소 키워드 → 고위험 카드, 그 외 → `send_status`). `max_turns=8`, 동일 (tool, args) 반복은 중단.
- 도구: 저위험 `lookup_order` / `lookup_shipping` / `send_status` 는 즉시 실행 후 outgoing `message_created`와 `helpdesk.tasks.outbound.<channel>`(web은 realtime만). 고위험 `refund` / `cancel_subscription` / `change_plan` 은 `tool_execution`(requires_approval) + `content_type=form` 승인 카드만 낸다.
- 승인 후 `ai.execute`가 같은 도구를 실행하고 결과를 고객에게 보낸다.
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
python -m pytest
python -m aura_ai
```

환경변수: `AURA_DSN`, `AURA_NATS_URL`, `AURA_LLM_BASE_URL`, `AURA_LLM_API_KEY`, `AURA_LLM_MODEL`, `AURA_EMBEDDING_MODEL`.
