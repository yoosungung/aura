# ARCHITECTURE.md

Aura의 **컴포넌트 간 계약**과 그 계약을 구현하는 **인터페이스 형태**다. 기획 원본은 [docs/설계서.md](docs/설계서.md)(NATS 백본·온톨로지·AI), [docs/헬프데스크 솔루션 구현 분석.md](docs/헬프데스크%20솔루션%20구현%20분석.md)(티켓 FSM·옴니채널·SLA·CSAT·위젯·API), [docs/아키텍처_개선.md](docs/아키텍처_개선.md)(장기 운영 점검), [docs/UI_UX_레이아웃_설계안.md](docs/UI_UX_레이아웃_설계안.md)(상담원 셸·위젯 공간), [docs/프론트엔드_위젯_검토.md](docs/프론트엔드_위젯_검토.md)(프론트·위젯 결함)다. 일정은 [ROADMAP.md](ROADMAP.md). 컴포넌트 내부 설계는 해당 폴더의 `DESIGN.md`.

§1은 규칙(왜). §2 이후는 형태(어떻게). 규칙이 바뀌면 §1을 먼저 고친다.

## 1. 계약사항

1. **NATS 단일 백본.** 서비스 간 HTTP/gRPC 호출을 두지 않는다. 비동기 이벤트, 작업 큐, 동기 질의는 모두 NATS다. Redis Pub/Sub·Sidekiq를 도입하지 않는다.
2. **Zero DB Direct Write (게이트웨이·AI).** 채널 게이트웨이, 위젯, `svc-ai-agent`는 PostgreSQL에 INSERT/UPDATE/DELETE 하지 않는다. 메시지·첨부·온톨로지·도구감사·CSAT·적용 SLA는 NATS `helpdesk.events.>` 로 발행하고 `svc-ingestion-worker`만 배치 적재한다. **컨택트·대화 생성과 `conversations.status` 전이는 `svc-core`가 PG에 동기 커밋**한 뒤 같은 트랜잭션에서 이벤트를 발행한다(Transactional Outbox). 설정 도메인(계정·인박스·멤버·규칙·SLA 정책·매크로·웹훅·문서)도 `svc-core`가 PG에 직접 쓴다.
3. **`svc-core`가 대화 마스터를 쓴다.** 목록·스레드·Ego-Graph·FSM 허용 여부 계산은 PG SELECT와 NATS Request-Reply다. 상태 컬럼은 core가 전이 트랜잭션에서 `version` CAS로 갱신한다. `status_changed`의 `expected_version`이 행의 `version`과 다르면 거절한다. ingestion은 동일 PK를 멱등 업서트할 뿐, 전이를 결정하지 않는다. 게이트웨이는 대화가 없으면 core의 생성 RPC가 성공한 뒤에만 `message_created`를 발행한다.
4. **단일 PostgreSQL.** 헬프데스크 관계형 스키마, pgvector, Ego-Graph(`ontology_nodes`/`ontology_edges`)를 한 클러스터의 ACID 트랜잭션으로 다룬다. 대화 그래프를 별도 DB에 두지 않는다.
5. **채널 장애 격리.** `gateway-web` / `gateway-kakao` / `gateway-email` / `gateway-social`은 독립 프로세스다. 한 채널 장애가 다른 채널 인입을 막지 않는다.
6. **테넌트 격리는 PG RLS.** `account_id`가 있는 테이블은 RLS ENABLE + FORCE다. 요청 트랜잭션 안에서만 `SELECT set_config('app.current_account_id', $id, true)` 한다. 커넥션 풀에 테넌트 GUC를 남기지 않는다. 애플리케이션 WHERE만으로 격리를 끝내지 않는다. 정책 식의 `current_setting(...)`은 `(SELECT …)`로 감싸 InitPlan으로 한 번만 평가한다.
7. **발행자가 UUIDv7로 ID를 만든다.** 이벤트 도메인 PK는 RFC 9562 UUIDv7이고, 게이트웨이와 `svc-core`가 생성한다. `SERIAL` PK에 `ON CONFLICT (id)` 로 멱등을 만들지 않는다. 재전송은 `ON CONFLICT (id) DO NOTHING` 또는 도메인 UNIQUE(`source_id`)로 막는다. PostgreSQL은 16+를 유지하므로 DB `DEFAULT`는 `gen_random_uuid()`를 쓸 수 있으나, 이벤트 도메인 행은 `DEFAULT`에 의존하지 않는다.
8. **Realtime은 유실을 허용한다.** typing·presence·큐 푸시는 NATS Core(`helpdesk.realtime.>`)다. 대화 불변 로그는 JetStream Limits 90일(`helpdesk.events.>`). 작업은 JetStream WorkQueue(`helpdesk.tasks.>`).
9. **WorkQueue 컨슈머 필터는 겹치지 않는다.** `helpdesk.tasks.ai.>`, `helpdesk.tasks.outbound.>`, `helpdesk.tasks.ontology.>`, `helpdesk.tasks.webhooks.>`, `helpdesk.tasks.sla.>`, `helpdesk.tasks.snooze.>` 로 분리한다.
10. **상담원과 고객의 realtime 구독은 토큰으로 가른다.** User 토큰은 배속 인박스 범위, Contact 토큰은 자기 대화만. 위젯 `postMessage`는 등록 origin만 받고, `setUser`는 서버 HMAC을 검증한다. `setUser` identify는 현재 컨택트에 identifier만 쓴다. 이미 식별된 컨택트와 identifier가 겹치면 거절한다. 익명 컨택트(identifier 없음)는 HMAC 통과 뒤 `contact_merged`로 티켓 `contact_id`만 기존 식별 컨택트로 옮긴다. 대화 스레드는 합치지 않는다. API·WS는 짧은 만료 HMAC 접근 토큰만 받는다. `users.pubsub_token` / `contact_inboxes.pubsub_token`은 시드이며 Bearer·쿼리 토큰으로 쓰지 않는다.
11. **카카오 세션은 30일이다.** 상담톡은 고객 마지막 메시지 후 30일, 세션이 있을 때만 발송한다. 알림톡(세션 없이 승인 템플릿)은 출시 후. WhatsApp 24시간 창은 `gateway-social` 전용이다.
12. **이벤트 Envelope는 하위 호환으로만 진화한다.** `schema_version`은 필수다. 필드 삭제·의미 변경을 하지 않는다. 필수 필드를 추가할 때는 기본값을 정한다. `trace_id`(W3C Trace Context), `causation_id`(유발 이벤트 id, 최초 발행이면 생략), `hop_count`를 넣는다. `hop_count > 5`인 이벤트는 자동화가 드롭한다.
13. **ingestion은 독성 이벤트 때문에 배치를 무한 NACK하지 않는다.** 플러시 순서는 `contacts` → `contact_inboxes` → `conversations` → `messages` → `attachments` → 상태/배정이다. 배치 트랜잭션이 실패하면 단건(또는 `SAVEPOINT`)으로 폴백하고, 영구 실패는 `helpdesk.dlq.ingestion`으로 보낸 뒤 ACK한다.
14. **상담원 인증은 자체 세션이다.** 이메일+비밀번호. P3에 OIDC를 두지 않는다. 비밀번호는 Argon2id로만 저장한다. 세션 행은 `svc-core`가 PG에 커밋하고, `gateway-web`이 접근 토큰을 서명한다. 게이트웨이는 `users`를 읽지 않는다.
15. **인박스 HMAC 시크릿은 administrator만 본다.** 호스트 서버가 identifier를 서명하고, 위젯·Client API·상담원에게 시크릿을 주지 않는다. 회전은 `inboxes.hmac_secret`을 즉시 덮어쓰며 이전 키를 남기지 않는다.

## 2. 토폴로지와 서비스 경계

```
[위젯 SDK]  [카카오]  [이메일]  [WhatsApp/SMS — P7 이후]
     │          │         │            │
gateway-web  gateway-kakao  gateway-email  gateway-social
     └──────────┴─────────┴────────────┘
                    │ 정규화 JSON
            NATS (Core + JetStream)
        realtime.>    events.>    tasks.>
                    │
     ┌──────────────┼──────────────┐
ingestion-worker  svc-core    svc-ai-agent
     │            svc-sla-routing
     │            svc-automation
     ▼
 PostgreSQL 16+ (RLS, pgvector, ontology)
```

| 컴포넌트 | 책임 | PG |
|---|---|---|
| `gateway-web` | 위젯·상담원 WebSocket, Client API, 인입 정규화, realtime 브리지 | 없음 |
| `gateway-kakao` | 상담톡 웹훅·아웃바운드. 알림톡은 출시 후 | 없음 |
| `gateway-email` | SMTP `:25` MIME 수신, In-Reply-To 스레딩, SMTP 발송 | 없음 |
| `gateway-social` | WhatsApp/SMS. P7 이후 | 없음 |
| `svc-ingestion-worker` | `helpdesk.events.>` Pull 배치(500건 또는 100ms). 계층 정렬·단건 폴백·DLQ | 메시지·첨부·온톨로지·도구감사·CSAT·적용 SLA. 컨택트·대화는 멱등 업서트 |
| `svc-core` | FSM, 컨택트·대화 생성, Application/Platform API, 설정 CRUD, Request-Reply | 설정 쓰기, `contacts`/`conversations` 쓰기, 나머지 이벤트 도메인 읽기 |
| `svc-sla-routing` | 라운드로빈·capacity, FRT/NRT/RT 감시. `C_current`는 JetStream KV 원자 증감(P5), PG는 대사 | 읽기. 전이는 이벤트 |
| `svc-automation` | Event → Conditions → Actions. `hop_count > 5`면 드롭. P5 액션은 `add_label`/`change_priority`. 웹훅은 P6 | 읽기. 티켓 필드 액션은 직접 쓰기. 웹훅은 이벤트 |
| `svc-ai-agent` | Ego-Graph 읽기, ReAct/Tool, 온톨로지 추출 요청 | Ego-Graph 읽기만 |
| `frontend` | 상담원 Rail + 3-Pane SPA | 없음 |
| `packages/widget-sdk` | 호스트 런처(Shadow DOM) + 교차출처 iframe + postMessage | 없음 |

동기 조회(대화 목록, Ego-Graph, FSM 허용 전이)와 컨택트·대화 생성은 NATS Request-Reply 또는 `svc-core` HTTP다. 게이트웨이끼리, AI가 게이트웨이를 HTTP로 부르지 않는다.

## 3. NATS 스트림과 서브젝트

로컬 1 replica. 프로덕션 3 replica. 스트림 이름은 바꾸지 않는다.

```
nats stream add CONVERSATIONS_STREAM \
  --subjects "helpdesk.events.*.*.*.*" \
  --storage file --retention limits --max-age 90d --discard old

nats stream add TASKS_STREAM \
  --subjects "helpdesk.tasks.>" \
  --storage file --retention workqueue --allow-msg-schedules --max-age 7d

nats stream add INGESTION_DLQ \
  --subjects "helpdesk.dlq.ingestion" \
  --storage file --retention limits --max-age 30d
```

`helpdesk.realtime.>` 와 `helpdesk.rpc.>` 는 스트림에 넣지 않는다. RPC는 NATS Core Request-Reply다.

JetStream KV 버킷 `AGENT_CAPACITY`: 키 `{account_id}.{user_id}`는 `C_current`, `{account_id}.{inbox_id}.rr`은 라운드로빈 커서. `Update(revision)`으로만 증감한다. PG `conversations.assignee_id`는 대사다.

| 구분 | 서브젝트 | 핵심 필드 | 발행 | 소비 |
|---|---|---|---|---|
| Core | `helpdesk.realtime.<account_id>.<conversation_id>.typing` | `user_type`, `user_id`, `is_typing` | gateway-\* | gateway-web |
| Core | `helpdesk.realtime.<account_id>.agent.presence` | `user_id`, `status` | svc-core | gateway-web |
| Core | `helpdesk.realtime.<account_id>.<conversation_id>.updated` | `event` (`conversation.created` 등) | ingestion 적재 후 또는 gateway | gateway-web, 위젯 |
| Core | `helpdesk.rpc.conversations.create` | `account_id`, `inbox_id`, `source_id`, `reuse_contact`(optional) | gateway-\* | svc-core |
| Core | `helpdesk.rpc.inboxes.resolve_email` | `email` | gateway-email | svc-core |
| Core | `helpdesk.rpc.inboxes.resolve_kakao` | `sender_key` | gateway-kakao | svc-core |
| Core | `helpdesk.rpc.conversations.resolve_thread` | `account_id`, `inbox_id`, `source_id`, `reply_ids`, `display_id` | gateway-email | svc-core |
| Core | `helpdesk.rpc.conversations.resolve_kakao` | `account_id`, `inbox_id`, `source_id`(msgKey), `user_key`. 같은 msgKey면 duplicate, 미해결 티켓이면 found | gateway-kakao | svc-core |
| Core | `helpdesk.rpc.conversations.transition` | `conversation_id`, `new_status`, `expected_version` | gateway-\* | svc-core |
| Core | `helpdesk.rpc.conversations.assign` | `actor_user_id`, `conversation_id`, `assignee_id`, `expected_version` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.note` | `actor_user_id`, `conversation_id`, `content` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.snooze` | `actor_user_id`, `conversation_id`, `snoozed_until`, `expected_version` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.label.add` | `actor_user_id`, `conversation_id`, `name` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.label.remove` | `actor_user_id`, `conversation_id`, `label_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.label.list` | `actor_user_id`, `conversation_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.labels.list` | `actor_user_id`, `account_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.labels.create` | `actor_user_id`, `account_id`, `name` | gateway-web | svc-core |
| Core | `helpdesk.rpc.canned.list` | `actor_user_id`, `account_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.canned.create` | `actor_user_id`, `account_id`, `short_code`, `content` | gateway-web | svc-core |
| Core | `helpdesk.rpc.macros.list` | `actor_user_id`, `account_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.macros.create` | `actor_user_id`, `account_id`, `name`, `actions`, `visibility` | gateway-web | svc-core |
| Core | `helpdesk.rpc.macros.execute` | `actor_user_id`, `account_id`, `conversation_id`, `macro_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.list` | `actor_user_id`, `account_id`, `inbox_ids`. 기본 `status <> 'resolved'`. 행에 `sla_breached` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.messages` | `actor_user_id`, `conversation_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.contacts.list` | `actor_user_id`, `account_id`, `inbox_ids` | gateway-web | svc-core |
| Core | `helpdesk.rpc.contacts.identify` | `inbox_id`, `contact_id`, `identifier`, `identifier_hash`. 익명+기존 identifier면 `contact_merged` 후 대상 `contact_id`. 식별된 충돌은 거절 | gateway-web | svc-core |
| Core | `helpdesk.rpc.auth.login` | `email`, `password` | gateway-web | svc-core |
| Core | `helpdesk.rpc.auth.refresh` | `session_token` | gateway-web | svc-core |
| Core | `helpdesk.rpc.auth.logout` | `session_token` | gateway-web | svc-core |
| Core | `helpdesk.rpc.auth.contact` | `inbox_id`, `pubsub_token` | gateway-web | svc-core |
| Core | `helpdesk.rpc.inbox_members.add` | `actor_user_id`, `inbox_id`, `user_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.inbox_members.remove` | `actor_user_id`, `inbox_id`, `user_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.inbox_members.list` | `actor_user_id`, `inbox_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.inboxes.get` | `actor_user_id`, `inbox_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.inboxes.rotate_hmac` | `actor_user_id`, `inbox_id` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.email_reply` | `actor_user_id`, `account_id`, `conversation_id`. 이메일 인박스면 `from`/`to`/`display_id`/`in_reply_to`, 아니면 `skip` | gateway-web | svc-core |
| Core | `helpdesk.rpc.conversations.kakao_reply` | `actor_user_id`, `account_id`, `conversation_id`. 카카오 인박스면 `from`(sender_key)/`to`(userKey)/`session_live`, 아니면 `skip` | gateway-web | svc-core |
| Limits | `helpdesk.events.<account_id>.<inbox_id>.<conversation_id>.message_created` | 아래 envelope | gateway-\*, svc-core | ingestion, sla-routing, automation, ai |
| Limits | `helpdesk.events.<account_id>.<inbox_id>.<conversation_id>.status_changed` | `old_status`, `new_status`, `expected_version` | svc-core | ingestion, sla-routing, automation |
| Limits | `helpdesk.events.<account_id>.<inbox_id>.<conversation_id>.assigned` | `assignee_id` | sla-routing, svc-core | ingestion, automation |
| Limits | `helpdesk.events.<account_id>.<inbox_id>.<conversation_id>.csat_submitted` | `rating`, `feedback` | gateway-\* | ingestion |
| Limits | `helpdesk.events.<account_id>.<inbox_id>.<conversation_id>.contact_merged` | `source_contact_id`, `target_contact_id` | svc-core | automation |
| WorkQueue | `helpdesk.tasks.ai.reasoning` | `conversation_id`, `trigger_message_id` | gateway-\*, svc-core | svc-ai-agent |
| WorkQueue | `helpdesk.tasks.outbound.<channel_type>` | `conversation_id`, `message_id`, `from`, `to`, `content`, `display_id`, `in_reply_to`, `source_id`, `session_live` | gateway-web, svc-ai-agent | gateway-\<channel_type\> |
| WorkQueue | `helpdesk.tasks.ontology.extract` | `contact_id`, `conversation_id` | svc-core (resolved 시) | svc-ai-agent |
| WorkQueue | `helpdesk.tasks.webhooks.deliver` | `webhook_id`, `event` | automation, svc-core | svc-core 워커 |
| WorkQueue | `helpdesk.tasks.sla.evaluate` | `conversation_id` | sla-routing 스케줄 | sla-routing |
| WorkQueue | `helpdesk.tasks.snooze.schedule.<conversation_id>` | `account_id`, `conversation_id`. 헤더 `Nats-Schedule: @at <RFC3339>`, `Nats-Schedule-Target` | gateway-web | (스케줄 보관, 컨슈머 없음) |
| WorkQueue | `helpdesk.tasks.snooze.wake.<conversation_id>` | `account_id`, `conversation_id` | JetStream 스케줄러 | svc-core |
| Limits | `helpdesk.dlq.ingestion` | 원본 envelope, `error` | ingestion | 운영 재처리 |

`<channel_type>` 은 `web` \| `kakao` \| `email` \| `social`.

## 4. 이벤트 JSON

모든 `helpdesk.events.>` 페이로드는 이 envelope다. 언어별 모델은 [contracts/](contracts/) JSON Schema에서 생성한다. Go는 `backend/internal/contracts`다.

```json
{
  "id": "0192d4f0-8c00-7000-8000-111111111111",
  "schema_version": 1,
  "type": "message_created",
  "occurred_at": "2026-10-28T05:00:00Z",
  "account_id": "0192d4ef-0000-7000-8000-aaaaaaaaaaaa",
  "inbox_id": "0192d4ef-0000-7000-8000-bbbbbbbbbbbb",
  "conversation_id": "0192d4ef-0000-7000-8000-cccccccccccc",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "causation_id": "0192d4f0-8b00-7000-8000-000000000000",
  "hop_count": 0,
  "payload": {}
}
```

`id` 는 UUIDv7 멱등 키이자, `message_created` 에서는 `messages.id` 와 같다. NATS 페이로드는 256KB를 넘기지 않는다. 초과 본문은 오브젝트 스토리지에 두고 payload에 `content_ref`만 넣는다.

**`message_created` payload**

```json
{
  "content": "결제 오류입니다",
  "message_type": 0,
  "private": false,
  "status": "sent",
  "content_type": "text",
  "source_id": "<optional external id>",
  "sender_type": "Contact",
  "sender_id": "dddddddd-dddd-dddd-dddd-dddddddddddd",
  "contact_id": "dddddddd-dddd-dddd-dddd-dddddddddddd",
  "contact_inbox_id": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  "attachments": []
}
```

`message_type`: `0` incoming, `1` outgoing, `2` activity, `3` template. `sender_type`: `User` \| `Contact` \| `AgentBot`. `content_type`: `text` \| `input_csat` \| `form`.

**`status_changed` payload**

```json
{
  "old_status": "open",
  "new_status": "resolved",
  "expected_version": 1,
  "actor_type": "User",
  "actor_id": "0192d4ef-0000-7000-8000-ffffffffffff"
}
```

`expected_version`은 전이 직전 `conversations.version`이다. 커밋이 성공하면 `version`은 `expected_version + 1`이 된다.

**`contact_merged` payload**

```json
{
  "source_contact_id": "0192d4ef-0000-7000-8000-dddddddddddd",
  "target_contact_id": "0192d4ef-0000-7000-8000-eeeeeeeeeeee"
}
```

HMAC이 통과한 익명 컨택트의 티켓만 옮긴다. `conversations.id`는 그대로다. 소스는 `merged_into_contact_id`만 찍고 삭제하지 않는다.

**`assigned` payload:** `assignee_id` (nullable = 미배정).

아웃바운드 웹훅 본문은 envelope를 펼친 공개 형태다. 헤더 `X-Helpdesk-Signature: sha256=<hex>`, `X-Helpdesk-Timestamp`. 검증식은 `HMAC-SHA256(timestamp + "." + body, webhook_secret)`. 타임스탬프 오차 5분 초과는 거절.

## 5. 대화 FSM

상태: `unassigned` \| `open` \| `pending` \| `snoozed` \| `resolved`.

| 상태 | 진입 | 부수 효과 | 다음 |
|---|---|---|---|
| `unassigned` | 고객 첫 인입, 담당자 없음 | 인박스 큐, 자동배정 큐, greeting | `open`, `pending`, `snoozed`, `resolved` |
| `open` | 배정 또는 수동 접수, reopen | FRT/NRT 타이머 | `pending`, `snoozed`, `resolved`, `unassigned` |
| `pending` | 상담원이 고객 확인 요청 | NRT 일시정지 | `open`, `resolved` |
| `snoozed` | `snoozed_until` 지정 | 큐 숨김. 시각 도래는 NATS 스케줄 → svc-core `WakeDue` FSM으로 `open`. 고객 메시지 시에도 `open` | `open`, `resolved` |
| `resolved` | 상담원/고객/규칙이 종결 | CSAT 발송, RT 확정, ontology extract 태스크 | `open` (고객 재인입, 같은 `conversation_id`) |

전이 결정은 `svc-core`. 허용되지 않은 전이와 `expected_version` 불일치는 Request-Reply 에러. 상태 컬럼은 core가 전이 트랜잭션에서 갱신하고, 같은 커밋에서 `status_changed`를 발행한다. ingestion은 이 이벤트를 멱등 반영할 뿐 전이를 승인하지 않는다.

## 6. API와 RBAC

서비스 간 호출이 아니라 **외부 클라이언트**용 HTTP다. 내부 상태 변경은 다시 NATS 이벤트로 떨어진다.

| 계층 | 호출자 | 인증 | 베이스 | 범위 |
|---|---|---|---|---|
| Application API | 상담원·관리자·SPA | User Bearer (짧은 만료 HMAC) | `/api/v1/accounts/{account_id}` | 배속 인박스의 대화·설정 |
| Client API | 위젯·모바일 | Contact Bearer (짧은 만료 HMAC) | `/public/api/v1/inboxes/{inbox_id}` | 자기 대화만 |
| Platform API | 슈퍼어드민·프로비저너 | platform token | `/platform/api/v1` | 테넌트·유저 생성 |

인증 경로 (계정 경로 밖):

- `POST /auth/sign_in` `{ email, password }` → `Set-Cookie: aura_session` (HttpOnly, SameSite=Lax, Path=/, 프로덕션만 Secure) + JSON `{ access_token, expires_in, user }`
- `POST /auth/refresh` 쿠키만. 새 `access_token`
- `DELETE /auth/sign_out` 세션 폐기, 쿠키 삭제
- `POST /public/api/v1/inboxes/{inbox_id}/auth` `{ pubsub_token }` → Contact `access_token`
- `POST /public/api/v1/inboxes/{inbox_id}/identify` `{ identifier, identifier_hash, name, email }`

세션 쿠키는 refresh/logout 전용이다. SPA는 쿠키를 읽지 않고 `access_token`을 메모리에 둔다. API는 `Authorization: Bearer`, WS는 `/ws?token=`. 접근 토큰 TTL은 15분, 세션은 7일. 클레임에 `exp`와 `sid`가 없으면 거절한다. 비밀번호는 Argon2id(m=19456 KiB, t=2, p=1). 쿠키에는 난수를 두고 DB에는 SHA-256 다이제스트만 둔다.

대표 경로:

- `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`
- `POST /api/v1/accounts/{account_id}/conversations/{id}/attachments`
- `POST /api/v1/accounts/{account_id}/conversations/{id}/notes`
- `PUT /api/v1/accounts/{account_id}/conversations/{id}/assignee`
- `PUT /api/v1/accounts/{account_id}/conversations/{id}/snooze`
- `GET /api/v1/accounts/{account_id}/conversations/{id}/labels`
- `POST /api/v1/accounts/{account_id}/conversations/{id}/labels`
- `DELETE /api/v1/accounts/{account_id}/conversations/{id}/labels/{label_id}`
- `GET /api/v1/accounts/{account_id}/labels`
- `POST /api/v1/accounts/{account_id}/labels`
- `GET /api/v1/accounts/{account_id}/canned_responses`
- `POST /api/v1/accounts/{account_id}/canned_responses`
- `GET /api/v1/accounts/{account_id}/macros`
- `POST /api/v1/accounts/{account_id}/macros`
- `POST /api/v1/accounts/{account_id}/conversations/{id}/macros/{macro_id}/execute`
- `PUT /api/v1/accounts/{account_id}/inboxes/{inbox_id}/members/{user_id}`
- `GET /api/v1/accounts/{account_id}/inboxes/{inbox_id}`
- `POST /api/v1/accounts/{account_id}/inboxes/{inbox_id}/hmac/rotate`
- `GET /api/v1/accounts/{account_id}/conversations` (기본 작업 큐, `resolved` 제외. 담당자 쿼리 없음)
- `GET /api/v1/accounts/{account_id}/conversations/{id}/messages`
- `PUT /api/v1/accounts/{account_id}/conversations/{id}/status`
- `GET /api/v1/accounts/{account_id}/contacts`
- `POST /public/api/v1/inboxes/{inbox_id}/contacts/{contact_id}/conversations/{id}/messages`
- `POST /platform/api/v1/accounts`

| 권한 | Super Admin | Administrator | Agent | Collaborator |
|---|---|---|---|---|
| 테넌트 생성·쿼터 | O | | | |
| 인박스·자동화·SLA·상담원 초대 | O | O | | |
| 웹 인박스 HMAC 시크릿 열람·회전 | O | O | | |
| 라벨 카탈로그·저장응답·공유 매크로 | O | O | | |
| 리포트·CSAT 리뷰 | O | O | | |
| 배속 인박스 열람·대고객 답장 | O | O | O | |
| 라벨 부착·매크로 실행·personal 매크로 | O | O | O | |
| 내부 메모 | O | O | O | O |

라벨은 계정 카탈로그(`labels`, 이름 유일)와 티켓 조인(`conversation_labels`)이다. 카탈로그 생성은 administrator. 티켓 부착은 있는 이름만이고, 없는 이름은 administrator만 upsert한다. 제거는 조인만 지운다. 상태는 FSM, 라벨은 주제·고객 신호·다음 일이다.

저장응답은 `canned_responses.short_code`다. 에디터 `/short_code`는 본문만 넣고 전송은 상담원이 한다. 생성은 administrator.

매크로 `actions`는 `{ "action_name", "action_params": [] }` 배열이다. P3 허용 이름: `send_message`, `add_label`, `add_private_note`, `assign_agent`, `snooze_conversation`, `resolve_conversation`. 실행은 상담원이 고른 뒤에만 `svc-core`가 기존 RPC와 같은 쓰기를 순서대로 한다. `visibility`는 `account`(관리자) 또는 `personal`(상담원 생성 시 강제).

Agent라도 `inbox_members`에 없는 인박스 대화는 목록·읽기 모두 거절.

Realtime 접근 토큰: User는 배속 인박스의 `helpdesk.realtime.<account_id>.>` 중 인가된 conversation. Contact는 해당 `conversation_id` 만. 구독 범위는 로그인/시드 교환 시 `inbox_members`에서 스냅샷한 클레임이다.

## 7. 위젯 보안

호스트는 로더 스크립트만 넣고 본체는 iframe이다. 닫힘 상태에서 iframe이 호스트 클릭을 가로채지 않는다. 런처(배지 포함)는 호스트 Shadow DOM이고, 채팅 iframe은 열림일 때만 표시한다.

- `postMessage` 수신부는 `event.origin` 이 등록된 헬프데스크 origin(또는 허용 호스트)이 아니면 return. origin 미검증 금지.
- `window.$aura.setUser(identifier, { name, email, identifier_hash })` 의 `identifier_hash` 는 서버 HMAC-SHA256(`identifier`, inbox HMAC secret) **소문자 hex**. 불일치면 식별자 바인딩 거부. identify는 현재 컨택트에 identifier만 쓴다. 이미 식별된 컨택트와 겹치면 거절한다. 익명 컨택트는 HMAC 통과 뒤 `contact_merged`로 티켓 `contact_id`만 옮기고 스레드는 그대로 둔다. `hmac_secret`은 웹 인박스 administrator GET/rotate만 반환한다. 호스트 서버가 env에 복사하고 페이지에는 해시만 심는다. 회전은 컬럼을 즉시 덮어쓴다. 위젯·Client API·Agent·이메일/카카오 인박스는 시크릿을 받지 않는다.
- 고객 WS는 Contact 토큰만 사용한다.

## 8. Ego-Graph 읽기

중심은 `entity_type = 'Customer'` 이고 `external_ref_id = contacts.id` 인 노드다. `svc-ai-agent`와 우측 패널은 이 고객의 **1~2홉**만 읽는다. 추론 중 그래프를 쓰지 않는다. 쓰기는 resolved 후 `helpdesk.tasks.ontology.extract` → 추출 이벤트 → ingestion.

```sql
WITH center AS (
  SELECT id FROM ontology_nodes
  WHERE account_id = current_setting('app.current_account_id')::uuid
    AND entity_type = 'Customer'
    AND external_ref_id = $contact_id
),
hop1 AS (
  SELECT e.target_node_id AS node_id, e.relation_type, 1 AS hop
  FROM ontology_edges e
  JOIN center c ON e.source_node_id = c.id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
  UNION ALL
  SELECT e.source_node_id, e.relation_type, 1
  FROM ontology_edges e
  JOIN center c ON e.target_node_id = c.id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
),
hop2 AS (
  SELECT e.target_node_id AS node_id, e.relation_type, 2 AS hop
  FROM ontology_edges e
  JOIN hop1 h ON e.source_node_id = h.node_id
  JOIN ontology_nodes n ON n.id = e.target_node_id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND h.hop = 1
    AND n.entity_type <> 'Customer'
)
SELECT n.id, n.entity_type, n.name, n.properties, x.relation_type, x.hop
FROM (
  SELECT * FROM hop1
  UNION
  SELECT * FROM hop2
) x
JOIN ontology_nodes n ON n.id = x.node_id
ORDER BY x.hop ASC, n.updated_at DESC
LIMIT 50;
```

`entity_type`: `Customer` \| `Product` \| `PainPoint` \| `Preference` \| `Feature`. `relation_type`: `PREFERS` \| `EXPERIENCED` \| `CAUSED_BY` \| `RESOLVED_BY`.

## 9. RLS

테넌트 트랜잭션:

```sql
BEGIN;
SELECT set_config('app.current_account_id', '<account uuid>', true);
-- queries
COMMIT;
```

`account_id` 컬럼이 있는 모든 테이블:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>_tenant ON <t>
  USING (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid))
  WITH CHECK (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid));
```

ingestion은 배치를 `account_id`로 묶고 그룹마다 위 트랜잭션을 연다. `users`와 `sessions`는 글로벌이라 RLS 없음. `account_users`는 RLS 있음. 마이그레이션·슈퍼유저는 `FORCE`를 우회하므로 런타임 롤은 `NOBYPASSRLS` 일반 롤이다.

## 10. DDL

PostgreSQL 16+. 이벤트 도메인 PK는 발행자가 만든 UUIDv7. 이 절이 스키마 정본이다. P1 `0001_init.sql`은 `password_digest`/`sessions`가 없고, P3 마이그레이션이 추가한다.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    locale VARCHAR(10) DEFAULT 'ko' NOT NULL,
    domain VARCHAR(255),
    custom_attributes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE account_sequences (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_conversation_display_id BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    password_digest TEXT NOT NULL,
    availability_status VARCHAR(50) DEFAULT 'offline' NOT NULL,
    pubsub_token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_digest VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE account_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_account_user UNIQUE (account_id, user_id)
);

CREATE TABLE inboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    channel_type VARCHAR(50) NOT NULL,
    enable_auto_assignment BOOLEAN DEFAULT TRUE NOT NULL,
    auto_assignment_capacity INT NOT NULL DEFAULT 100,
    greeting_message TEXT,
    business_hours_enabled BOOLEAN DEFAULT FALSE NOT NULL,
    business_hours JSONB DEFAULT '{}'::jsonb NOT NULL,
    hmac_secret VARCHAR(255) NOT NULL,
    email_address VARCHAR(255),
    kakao_sender_key VARCHAR(255),
    kakao_alimtalk_template VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE inbox_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_inbox_user UNIQUE (inbox_id, user_id)
);

CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255),
    email VARCHAR(255),
    phone_number VARCHAR(50),
    identifier VARCHAR(255),
    merged_into_contact_id UUID REFERENCES contacts(id),
    custom_attributes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_contact_email_account UNIQUE (account_id, email),
    CONSTRAINT uq_contact_identifier_account UNIQUE (account_id, identifier)
);

CREATE TABLE contact_inboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    source_id VARCHAR(255) NOT NULL,
    pubsub_token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_inbox_source UNIQUE (inbox_id, source_id)
);

CREATE TABLE conversations (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    contact_inbox_id UUID NOT NULL REFERENCES contact_inboxes(id) ON DELETE CASCADE,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'unassigned' NOT NULL,
    priority VARCHAR(50) DEFAULT 'medium' NOT NULL,
    first_reply_created_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    snoozed_until TIMESTAMPTZ,
    display_id BIGINT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    custom_attributes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_conversation_display UNIQUE (account_id, display_id)
);

CREATE TABLE messages (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_type INT NOT NULL,
    content TEXT,
    private BOOLEAN DEFAULT FALSE NOT NULL,
    status VARCHAR(50) DEFAULT 'sent' NOT NULL,
    source_id VARCHAR(255),
    content_type VARCHAR(50) DEFAULT 'text' NOT NULL,
    sender_type VARCHAR(50) NOT NULL,
    sender_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_message_source UNIQUE (inbox_id, source_id)
);

CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_type VARCHAR(50) NOT NULL,
    external_url TEXT NOT NULL,
    file_size INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    color VARCHAR(32),
    CONSTRAINT uq_label_name UNIQUE (account_id, name)
);

CREATE TABLE conversation_labels (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, label_id)
);

CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    CONSTRAINT uq_team_name UNIQUE (account_id, name)
);

CREATE TABLE team_members (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    short_code VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    CONSTRAINT uq_canned UNIQUE (account_id, short_code)
);

CREATE TABLE macros (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    actions JSONB NOT NULL,
    visibility VARCHAR(50) DEFAULT 'account' NOT NULL,
    created_by UUID REFERENCES users(id)
);

CREATE TABLE automation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    conditions JSONB NOT NULL,
    actions JSONB NOT NULL,
    enabled BOOLEAN DEFAULT TRUE NOT NULL
);
-- conditions: [{attribute_key, filter_operator, values}] Chatwoot 호환. AND.
-- actions: [{action_name, action_params}]. P5는 add_label / change_priority.

CREATE TABLE sla_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    frt_threshold_seconds INT,
    nrt_threshold_seconds INT,
    rt_threshold_seconds INT,
    only_business_hours BOOLEAN DEFAULT TRUE NOT NULL
);

CREATE TABLE applied_slas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sla_policy_id UUID NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
    frt_due_at TIMESTAMPTZ,
    nrt_due_at TIMESTAMPTZ,
    rt_due_at TIMESTAMPTZ,
    is_frt_breached BOOLEAN DEFAULT FALSE NOT NULL,
    is_nrt_breached BOOLEAN DEFAULT FALSE NOT NULL,
    is_rt_breached BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE csat_survey_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    assigned_agent_id UUID REFERENCES users(id),
    rating INT NOT NULL,
    feedback TEXT,
    review_note TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    subscriptions TEXT[] NOT NULL,
    secret VARCHAR(255) NOT NULL
);

CREATE TABLE articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    published BOOLEAN DEFAULT FALSE NOT NULL,
    embedding vector(1536),
    CONSTRAINT uq_article_slug UNIQUE (account_id, slug)
);

CREATE TABLE ontology_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    external_ref_id VARCHAR(255),
    properties JSONB DEFAULT '{}'::jsonb NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE ontology_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_node_id UUID NOT NULL REFERENCES ontology_nodes(id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES ontology_nodes(id) ON DELETE CASCADE,
    relation_type VARCHAR(100) NOT NULL,
    weight FLOAT DEFAULT 1.0 NOT NULL,
    properties JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_edge UNIQUE (account_id, source_node_id, target_node_id, relation_type)
);

CREATE TABLE agent_tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    input_args JSONB NOT NULL,
    output_result JSONB NOT NULL,
    is_success BOOLEAN NOT NULL,
    requires_approval BOOLEAN DEFAULT FALSE NOT NULL,
    approved_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_conversations_account_status ON conversations(account_id, status);
CREATE INDEX idx_conversations_assignee_open ON conversations(account_id, assignee_id) WHERE status = 'open';
CREATE INDEX idx_messages_conv_created ON messages(account_id, conversation_id, created_at ASC);
CREATE INDEX idx_contact_inboxes_lookup ON contact_inboxes(account_id, inbox_id, source_id);
CREATE INDEX idx_ontology_nodes_ref ON ontology_nodes(account_id, entity_type, external_ref_id);
CREATE INDEX idx_ontology_edges_traversal ON ontology_edges(account_id, source_node_id, relation_type);
```

`channel_type`: `web` \| `kakao` \| `email` \| `social`. `availability_status`: `online` \| `offline` \| `busy`. `priority`: `low` \| `medium` \| `high` \| `urgent`. `messages.status`: `sent` \| `delivered` \| `read` \| `failed`. `conversations.display_id` 는 이메일 제목 `[#REQ-{display_id}]` 토큰이다. 채번은 `account_sequences`에서 `INSERT ... ON CONFLICT (account_id) DO UPDATE SET last_conversation_display_id = account_sequences.last_conversation_display_id + 1 RETURNING last_conversation_display_id` 로만 한다. `MAX(display_id)+1` 금지.

이메일 스레딩 순서: (1) `In-Reply-To`/`References` → `messages.source_id` (2) 본문 구분자 `##- Please type your reply above this line -##` (3) 제목 `[#REQ-{display_id}]` (4) 없으면 새 대화.

`gateway-email` 아웃바운드는 WorkQueue `helpdesk.tasks.outbound.email`이다. 상담원 답장은 `gateway-web`이 `conversations.email_reply`로 인박스 채널을 확인하고, 이메일이면 `message_created`(`payload.source_id`=Message-ID) 뒤에 태스크를 넣는다. 게이트웨이는 From=인박스 `email_address`, To=`contact_inboxes.source_id`, 제목 `[#REQ-{display_id}]`, `In-Reply-To`/`References`, 본문 구분자 `##- Please type your reply above this line -##` 로 MIME을 만들어 `AURA_SMTP_RELAY`(기본 `127.0.0.1:2525`)로 보낸다. PG는 쓰지 않는다.

`gateway-email` 인입은 SMTP `:25`(환경 `AURA_SMTP_ADDR`)다. MX·포워딩이 DATA에 넣는 MIME이 신뢰 경계이며, 웹훅 HMAC 서명은 없다. `inboxes.email_address`는 소문자 UNIQUE이고, 테넌트 GUC 없이 `inbox_by_email` SECURITY DEFINER로만 조회한다. Session.Data가 `emersion/go-message`로 파싱·스레딩한다. 본문이 NATS 256KB를 넘기면 SeaweedFS에 raw MIME을 두고 payload `content_ref`만 넣는다. PG는 쓰지 않는다. 같은 Message-ID는 `message_created`를 재발행하지 않는다. 스레드가 없으면 `conversations.create`(`reuse_contact=true`, `contact_inboxes.source_id`=From)가 성공한 뒤에만 `message_created`(`payload.source_id`=Message-ID)를 JetStream에 발행한다.

`gateway-kakao` 인입은 HTTP `POST /cstalk/message`(환경 `AURA_KAKAO_ADDR`, 기본 `:8081`)다. 웹훅 JSON이 신뢰 경계다. `inboxes.kakao_sender_key`는 UNIQUE이고, 테넌트 GUC 없이 `inbox_by_kakao` SECURITY DEFINER로만 조회한다. `userKey`는 `contact_inboxes.source_id`, `msgKey`는 `messages.source_id`다. 같은 msgKey는 `message_created`를 재발행하지 않는다. 그 컨택트의 미해결 대화가 있으면 붙이고, 없으면 `conversations.create`(`reuse_contact=true`)가 성공한 뒤에만 발행한다. 응답은 `{"code":"A000","result":"Success"}`. PG는 쓰지 않는다.

`gateway-kakao` 아웃바운드는 WorkQueue `helpdesk.tasks.outbound.kakao`다. 상담원 답장은 `gateway-web`이 `conversations.kakao_reply`로 채널을 확인하고, 카카오이고 세션이 살아 있으면 `message_created` 뒤에 태스크를 넣는다. 세션은 고객 마지막 인입 메시지 후 30일이다. 허브 `POST {AURA_KAKAO_API_URL}/cstalk/plain`(`senderKey`/`userKey`/`msgType=TEXT`), 인증은 `AURA_KAKAO_API_KEY`. 세션이 꺼져 있으면 티켓에는 남고 카카오로는 보내지 않는다. 알림톡은 출시 후. PG는 쓰지 않는다.

첨부 `external_url` 은 오브젝트 스토리지(로컬 SeaweedFS 필러). 게이트웨이는 파일을 `{account_id}/{attachment_id}/` 경로에 올린 뒤 URL만 이벤트에 넣는다. `message_created` payload `attachments` 원소는 `{ id, file_type, external_url, file_size }`다. ingestion이 `attachments` 행을 멱등 insert한다.

대표 경로:
- `POST /api/v1/accounts/{account_id}/conversations/{id}/attachments` (multipart `file` + `inbox_id`·`contact_id`·`contact_inbox_id`)
