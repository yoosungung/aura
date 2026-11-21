# ARCHITECTURE.md

Aura의 **컴포넌트 간 계약**과 그 계약을 구현하는 **인터페이스 형태**다. 일정은 [ROADMAP.md](ROADMAP.md). 컴포넌트 내부 설계는 해당 폴더의 `DESIGN.md`(코드 진입 시 생성).

제품: **Agent + MCP Serverless Runtime** (헬프데스크 CRM 아님). 참고만 — 계승 금지: 로컬 `aura_old`, [yoosungung/agent-runtime](https://github.com/yoosungung/agent-runtime).

---

## 1. 계약사항

1. **NATS 단일 백본.** MSA 통신은 NATS만 한다. 서비스 간 HTTP/gRPC를 두지 않는다. Redis Pub/Sub·별도 사이드카 큐를 도입하지 않는다. (예외: `svc-control` 관리 API, Gateway→클라이언트 **SSE/WebSocket** 브리지, 테넌트 MCP Streamable HTTP 경계.)
2. **실행 삼원화 (Fission + Core 스트림).** 프레임워크는 Fission이다. OpenFaaS·bare KEDA Deployment **폴백 없음**.
   - **비동기 파이프라인** (`aura.tasks.*`): 기본은 Fission MessageQueueTrigger(`mqtype=nats-jetstream`, `mqtkind=keda`). KEDA lag 스케일, idle 시 **scale-to-zero 허용** (`minReplicaCount = 0`). 내구성·완료 감사는 여기. **예외 — `agent_invoke` / `mcp_invoke` async**: 동일 subject에 다중 `runtime`(nodejs/python/custom)이 있으므로 **MQT 1:1 바인딩 대신** 공용 **`aura-nats-task-bridge`**(JetStream pull → Fission Router)가 대상을 고른다. 도메인 handler는 브리지에 두지 않는다. 이미지별 MQT 금지. memory 등 기타 tasks는 기존 MQT 유지. nodejs/python Environment는 런타임×계급 공용(`aura-nodejs-async` / `aura-python-async`, `poolmgr`, `poolsize ≥ 1`). **`runtime=custom`은 Package·Environment·specialize 없는 Fission container executor 이미지**다. 브리지는 payload `function`(Gateway가 resolve에서 스탬프)이 접두사 `aura-agent-invoke-` 또는 `aura-mcp-invoke-`(다만 `aura-mcp-invoke-rpc-` 제외, poolmgr 슬롯 이름 제외)일 때만 Router로 넘긴다. async container `MinScale=0` 허용.
   - **동기 RPC** (`aura.rpc.*`): NATS Core Request-Reply. **구독은 공용 `aura-nats-rpc-bridge`만**(replicas ≥ 2). 브리지는 handler를 실행하지 않고 Fission **router-internal**(`POST /fission-function/<name>`, 기본 `:8889`)로 중계한다. **`aura.rpc.mcp.tool`은 `runtime`→Function 매핑**(기본 nodejs). nodejs/python Sync Environment는 런타임×계급 공용(`aura-nodejs-sync` / `aura-python-sync`, **`poolmgr`**, `poolsize ≥ 2`). **`runtime=custom`도 같은 브리지**이며 container executor(`MinScale≥2`, 접두사 `aura-mcp-invoke-rpc-`)다. poolmgr는 임의 이미지를 specialize하지 못한다. 서비스별 `*-rr` Deployment·sync `newdeploy` MinScale 상주 **금지**. 이미지가 NATS에 직접 구독하지 않는다. Core RR은 JetStream lag가 없으므로 브리지·sync 풀을 scale-to-zero와 **함께 쓰지 않는다**.
   - **실시간 스트림** (`aura.stream.*`): NATS **Core** pub/sub. LLM 토큰·툴 상태 등 UX용. **유실 허용**(JetStream에 넣지 않음). 완료의 정본은 `aura.events.agent.invoke.done` / error다.
3. **단일 PostgreSQL + 필수 Connection Pooler.** 관계형 + pgvector + BM25(전문) + 그래프 엣지를 한 클러스터 ACID로 다룬다. 메모리 전용 외부 DB를 두지 않는다. 임베딩 인덱스는 **`halfvec` + `(model, version)` LIST 파티션** 패턴만 쓴다(§6.2.1). 차원 미지정 컬럼에 HNSW를 직접 걸지 않는다. FaaS/런타임 파드는 PG에 **직접 붙지 않고** **CloudNativePG `Pooler`**(transaction)만 경유한다(§2.1). standalone PgBouncer는 CNPG 미도입 폴백만.
4. **RLS 테넌트 GUC는 트랜잭션 로컬만.** `SELECT set_config('app.tenant_id', $1, true)` (세 번째 인자 `is_local = true`)만 허용한다. 세션 수명 `SET`/`set_config(..., false)` 금지 — transaction pooling에서 커넥션 재사용 시 테넌트 오염을 막는다.
5. **`svc-memory`가 메모리 PG 유일 쓰기 소유자.** `memory_items`·임베딩/BM25 문서·`memory_nodes`/`memory_edges`·메모리 감사에 INSERT/UPDATE/DELETE 하는 프로세스는 `svc-memory`뿐이다.
6. **`svc-control`이 컨트롤 메타 유일 쓰기 소유자.** `source_meta`/`user_meta`/테넌트·ACL 등 메타 쓰기는 `svc-control`만. 런타임 Function은 resolve **read**만.
7. **4유형 메모리.** `short_term` / `long_term` / `episodic` / `semantic`은 스키마·스코프·승격 규칙이 다르다. 유사도만으로 유형을 바꾸지 않는다.
8. **메모리 수명주기·파티셔닝.** `memory_items`는 **`memory_type` LIST(+ 단기 유형은 `created_at` RANGE)** 로 물리 분리한다. `memory_audit`는 **`created_at` RANGE(월)** 파티션이다. `short_term`은 내구 HNSW에 넣지 않으며 파티션 DROP/TTL로 제거한다. Soft delete(`valid_until`)만으로 단기·에피소딕 대량을 방치하지 않는다(§6.2.2). 콜드 에피소딕은 Object Storage(Parquet 등) 아카이브 후 파티션 DETACH/DROP.
9. **메모리 파이프라인.** capture → (event) → store/embed → retrieve → consolidate. Agent는 `aura.rpc.memory.recall`만 사용하고, 원문 전량을 프롬프트에 덤프하지 않는다.
10. **Zero Direct Write (런타임).** `agent_invoke` / `mcp_invoke` / `memory_capture`는 도메인 메모리를 PG에 쓰지 않는다. NATS 이벤트·태스크만 발행한다. 세션 체크포인트 등 런타임 예외 테이블은 §6에 명시한 것만 허용한다.
11. **번들 계약.** invoke payload는 식별자만 담는다. 코드·config는 `svc-control` resolve로 얻는다. factory 시그니처는 `(cfg, secrets) -> instance` (하위호환 zero-arg·1-arg 허용). **func-env 권위는 `source_meta.runtime`**(nodejs|python|custom; 기본 nodejs) — `svc-control`만 쓰기. 메시지 `runtime`은 Gateway 스탬프일 뿐이며 Function·이미지는 resolve로 재검증한다. `runtime=custom`일 때 Gateway는 resolve의 Router Function 이름을 payload `function`으로 같이 스탬프한다. 클라이언트가 `runtime`/`function`을 만들지 않는다. `user_meta`/`cfg`에 runtime을 두지 않는다.
12. **MCP 대칭.** agent→mcp는 NATS Request-Reply다. Aura 컴포넌트 사이에는 MCP 프로토콜을 두지 않는다. 테넌트/외부 MCP가 Streamable HTTP만 말할 때 `mcp_invoke` Function 경계에서만 HTTP 어댑터를 둔다.
13. **Agent UX 스트리밍 필수.** 대화형 `agent_invoke`는 실행 중 `aura.stream.<run_id>`(NATS Core)로 토큰·툴 진행 프레임을 publish한다. 클라이언트는 Gateway SSE/WebSocket 브리지로 구독한다. **done 이벤트만 기다리는 배치 UX를 대화형 경로의 기본으로 두지 않는다.**
14. **멀티테넌트 HNSW는 post-filter 함정을 계약으로 막는다.** 공유 `model_key` HNSW에서 `tenant_id` 필터만 걸고 전역 Top-K를 자르면 소형 테넌트 Recall이 0에 수렴할 수 있다. recall 트랜잭션은 **pgvector 0.8+ `hnsw.iterative_scan`을 켠 상태**에서 테넌트 조건과 ANN을 함께 평가한다(§6.2.3). M1에서 왜곡 테넌트 픽스처로 검증하고, 실패 시 테넌트 해시/대형 테넌트 분리 파티션으로 승격한다.
15. **그래프 순회는 방어적으로만.** `memory_edges` 1–2홉은 **유효 엣지만**, **출·입 방향 인덱스**, **홉/팬아웃 LIMIT**, **visited 사이클 방지**, **슈퍼노드 차수 캡**을 지킨다(§6.2.4). 무제한 재귀·무제한 JOIN 금지.
16. **테넌트 Fair Queue / Rate Limit은 출시 전 필수.** NATS Account 격리와 무관하게, 공유 `AURA_TASKS`에 대한 **Gateway 진입 제어**(테넌트별 Token Bucket + 동시 실행 상한)를 둔다(§2.2). 한 테넌트의 대량 `agent.invoke`가 다른 테넌트를 기아(starvation)에 빠뜨리면 안 된다.
17. **보안·비용·컴플라이언스 최소선(§9).** 테넌트 코드 샌드박스·Egress 격리, NATS mTLS·시크릿 마스킹·단기 캐시, GDPR 잊힐 권리(비식별화+crypto-shredding), **중앙 LLM Gateway**, 동기 경로 Warm Pool SLA, PG HA/DR 수치, JetStream **MaxDeliver+DLQ** — 출시 전 로드맵에 포함한다.

### 이것만은 하지 말 것

- OpenFaaS 또는 bare KEDA+Deployment로 Fission MQT를 대체하지 말 것.
- **`aura-nats-rpc-bridge` 또는 sync poolmgr(`aura-nodejs-sync` / `aura-python-sync`)를 scale-to-zero하지 말 것** — Core Request-Reply는 JetStream lag로 깨우지 못해 No Responders가 된다.
- **동일 `aura.tasks.agent.invoke` / `aura.tasks.mcp.invoke`에 언어별 MQT를 이중 구독하지 말 것** — task-bridge + `runtime` 매핑만.
- **서비스별 `aura-*-rr` Deployment로 sync handler를 다시 두지 말 것** — NATS 구독은 공용 브리지만, 로직은 Fission Sync Function만.
- 동기 RPC를 “깨우기용”으로 JetStream에 우회 적재하지 말 것 — 계약은 Core RR + 공용 브리지 + sync poolmgr Warm이다.
- **`aura.stream.*`를 JetStream에 넣거나 완료 정본으로 쓰지 말 것** — 유실 가능한 UX 채널이다. 완료·감사는 `aura.events.*`.
- **Function/파드가 PostgreSQL 호스트·포트에 직접 연결하지 말 것** — Connection Pooler VIP만.
- **`set_config('app.tenant_id', …, false)` 또는 세션 `SET app.tenant_id` 금지** — pool 재사용 시 RLS 오염.
- **`short_term`/`episodic` 대량을 `long_term`과 동일 내구 HNSW에 섞고 Soft delete만 하지 말 것** — 파티션 DROP/아카이브로 수명을 닫는다.
- **공유 HNSW에서 `ORDER BY embedding <=> q LIMIT K` 후 애플리케이션에서 `tenant_id`만 걸러 쓰지 말 것** — iterative_scan(또는 테넌트 파티션) 없이 소형 테넌트는 0건이 된다.
- **`memory_edges`를 depth·LIMIT·visited 없이 재귀 전개하지 말 것** — 슈퍼노드에서 1–2홉 fan-out 폭발.
- **쿼터 없이 `AURA_TASKS`에 테넌트 폭주를 publish하지 말 것** — 공유 WorkQueue FIFO는 noisy neighbor에 무방비다. NATS Account를 기다리지 않는다.
- **Function에서 LLM 제공자 API를 직접 호출하지 말 것** — 중앙 LLM Gateway만(§9.4).
- **시크릿 plaintext를 로그·OTel·NATS 페이로드 감사에 남기지 말 것.**
- **MaxDeliver 없는 무한 재시도로 poison 메시지를 돌리지 말 것** — DLQ로 격리(§3.2·§9.7).
- agent/mcp/capture에서 `memory_*` 테이블에 직접 쓰지 말 것.
- Agent가 PG에 직접 SELECT해 recall하지 말 것 — `aura.rpc.memory.recall`만.
- **recall 응답 외 memory 원문·`content_ref` 본문을 프롬프트에 덤프하지 말 것** — 슬롯·토큰 예산은 §6.3 · [`deploy/docs/agent-inject-contract.md`](deploy/docs/agent-inject-contract.md).
- 헬프데스크 FSM·옴니채널 게이트웨이·L0–L3 Semantic Pyramid 계약을 이 저장소에 되살리지 말 것.

---

## 2. 토폴로지와 서비스 경계

전체 메시지·호출 흐름 다이어그램: [MESSAGE-FLOW.md](MESSAGE-FLOW.md).

```
[Client]
   │  submit task          │  SSE / WebSocket (Gateway 브리지)
   ▼                       ▼
[Gateway] ──pub tasks──► NATS ◄──sub aura.stream.<run_id>── [Gateway]
                              │
        │ ── async AURA_TASKS (agent/mcp: task-bridge · memory: MQT; scale-to-zero OK) ──
        ├── aura-nats-task-bridge → agent_invoke / mcp_invoke (runtime→Function)
        │         └── agent_invoke ──pub──► aura.stream.<run_id> (Core, 유실 허용)
        ├── memory_capture   (MQT)
        ├── svc-memory store/embed/consolidate (MQT)
        │
        │ ── sync aura.rpc.* (Core RR → aura-nats-rpc-bridge → Fission Router) ──
        ├── aura-memory-recall      (poolmgr sync)
        ├── aura-mcp-invoke-rpc     (poolmgr sync)
        └── aura-control-resolve    (poolmgr sync)
                │
                ▼
   Connection Pooler → PostgreSQL 16+
```

| 컴포넌트 | 역할 | 실행 계급 | PG |
|----------|------|-----------|-----|
| **Gateway** | 태스크 **쿼터 검사·resolve `runtime` 스탬프 후** publish; `aura.stream.<run_id>` → 클라이언트 SSE/WS · **ns `aura`** | 상시 ≥2 | 없음(쿼터 상태는 NATS KV 등, §2.2) |
| **`aura-nats-task-bridge`** | `aura.tasks.agent.invoke` / `mcp.invoke` JetStream pull → `runtime`→Function → Fission Router · resp/error · **ns `aura`** · `TASK_MAX_INFLIGHT`(기본 32, HOL 금지) | Bridge **replicas≥2** · Function KEDA lag · **min=0** | 없음 |
| **`aura-nats-rpc-bridge`** | `aura.rpc.*` queue-group 구독 → Fission Router HTTP 중계 · **ns `aura`** | 상시 ≥2 | 없음 |
| `agent_invoke` | 턴 실행; recall/mcp/resolve RPC; **스트림 프레임 publish**; capture 발행; done/error 이벤트 | **async** task-bridge (0 허용) | 체크포인트만 (**Pooler**) |
| `mcp_invoke` (task) | 비동기 MCP 작업 | **async** task-bridge (0 허용) | 없음 |
| `mcp_invoke` (rpc) | `aura.rpc.mcp.tool` → Function `aura-mcp-invoke-rpc` | **sync** poolmgr Warm | 없음 |
| `memory_capture` | LLM 후보 추출 → 이벤트 | **async** MQT (0 허용) | **쓰기·읽기 금지** |
| `svc-memory` store/embed/consolidate | 적재·인덱스·승격 | **async** MQT (0 허용) | 메모리 **유일 쓰기** → **Pooler** |
| `svc-memory` recall | hybrid Top-K → Function `aura-memory-recall` | **sync** poolmgr Warm | 메모리 SELECT → **Pooler** |
| `svc-control` + resolve Function | 메타 쓰기(HTTP); `aura.rpc.control.resolve` → `aura-control-resolve` | 관리 HTTP + **sync** poolmgr Warm | 컨트롤 메타 **유일 쓰기** → **Pooler** |
| **`aura-control-admin`** | ops 관리 HTTP (`/v1/sources`·bundles·overlays·`/v1/audit`) · **ns `aura`** · Admin UI 전용 · Phase 2 quota는 NATS RR로 Gateway만 호출(KV 직접 금지) | 상시 ≥2 | 컨트롤 메타 쓰기 + `control_audit` → **Pooler**; Garage GetObject(activate checksum) |
| **Admin UI** | 플랫폼 ops 콘솔(소스·번들·overlay·audit). Chat UI·테넌트 self-serve **비범위** · Gateway HTTP 금지 | Vite SPA → `aura-control-admin`만 | 없음(API 경유) |
| **Connection Pooler** | FaaS fan-out ↔ PG `max_connections` 완충 | 상시 | **CloudNativePG `Pooler`**, **transaction** 모드 |

### 2.1 Connection Pooler · RLS GUC

Fission이 KEDA로 수십~수백 파드로 늘 때 각 프로세스가 PG에 붙으면 `max_connections` 고갈과, 세션 GUC가 붙은 채 커넥션이 풀에 반환되어 **테넌트 오염**이 난다. 그래서 Pooler는 토폴로지 **필수 계층**이다.

| 규칙 | 내용 |
|------|------|
| 제품 | **CloudNativePG `Pooler`** (`spec.pgbouncer.poolMode: transaction`). 앱 DSN 호스트는 **pooler Service DNS만** (예: `aura-pg-pooler.aura.svc.cluster.local`). standalone PgBouncer는 CNPG 미도입 폴백만. |
| 모드 | **transaction pooling** 기본. session pooling을 RLS+GUC 경로에 쓰지 않는다. |
| 테넌트 바인딩 | 매 요청/트랜잭션 시작: `SELECT set_config('app.tenant_id', $1, true);` 후 쿼리. `is_local=true` → COMMIT/ROLLBACK 시 GUC 해제. |
| 금지 | Function → PG Pod IP/직접 포트·primary Service; `SET app.tenant_id = ...`; `set_config(..., false)`; 요청 간 커넥션에 테넌트 상태 의존 |
| 클라이언트 | 짧은 트랜잭션; 트랜잭션 밖 prepared statement·세션 advisory lock에 의존하지 않음(transaction pool 제약). 필요 시 DESIGN에 예외를 명시. |

### 2.2 Noisy Neighbor · 테넌트 Fair Queue / Rate Limit

공유 `AURA_TASKS` WorkQueue는 기본적으로 **FIFO**다. NATS Account 격리(§9, 출시 후) 전까지도, 앱 계층에서 테넌트 기아를 막는다.

**집행 위치 (정본 = Gateway)**

1. 클라이언트 → Gateway 제출.
2. Gateway가 `tenant_id`에 대해 **Token Bucket**(제출 속도) + **in-flight 상한**(동시 `run_id`)을 검사.
3. 통과 시에만 `aura.tasks.agent.invoke`(및 동등 태스크) publish + `run_id` 발급.
4. 거부 시 JetStream에 넣지 않고 **429/쿼터 초과** 응답(및 선택적 `aura.stream` error 프레임).
5. `run.completed` / `aura.events.agent.invoke.done|error` 관찰 시 in-flight 감소(Gateway 또는 전용 감산 구독).

**방어 심화:** Gateway를 우회한 publish가 가능하면 `agent_invoke` 진입에서 동일 키로 쿼터를 재확인하고, 초과 시 ack 없이 재큐하지 말고 **poison/ DLQ·error 이벤트**로 종료(무한 재시도 금지). DESIGN에 우회 경로 유무를 명시한다.

**쿼터 키·상태**

| 항목 | 계약 |
|------|------|
| 키 | `tenant_id` (+ 선택 `agent` 플랜 tier) |
| 알고리즘 | **Token Bucket** (지속 rate + burst) + **max_inflight** 세마포어 |
| 상태 저장 | Gateway 레플리카 공유: **NATS JetStream KV**(권장) 또는 동등. Redis를 **큐 대용**으로 쓰지 않는다(§1.1). |
| 수치 | 플랜별 기본값 — M3 DESIGN 고정 초안: rate **10**/s, burst **30**, inflight **20** ([`deploy/docs/gateway-fair-queue.md`](deploy/docs/gateway-fair-queue.md)) |

**Fairness**

- 버킷이 비면 해당 테넌트만 지연/거절 — 다른 테넌트 publish는 막지 않는다.
- 전역 백프레셔(워커 lag 임계) 시: Gateway는 **모든** 테넌트에 대해 비례 축소(또는 초과 테넌트만 추가 제한). 알고리즘은 DESIGN.
- **승격(F1, 선택):** 테넌트별 subject `aura.tasks.agent.invoke.<tenant_bucket>` + 워커 fair round-robin — Account 없이도 큐 단 격리. M3 SLO 미달 시 결정 로그에 채택.

**적용 범위:** 대화형 `agent.invoke` 필수. `memory.*` 내부 파이프라인은 테넌트 폭주가 Gateway invoke에서 이미 제한되므로 동일 버킷을 쓰거나 더 느슨한 내부 한도를 DESIGN에 둔다.

---

## 3. NATS 스트림과 서브젝트

### 3.1 스트림

| 스트림 | retention | subject 필터 | 용도 |
|--------|-----------|--------------|------|
| `AURA_EVENTS` | Limits, 90일 | `aura.events.>` | 감사·적재 완료·도메인 이벤트 |
| `AURA_TASKS` | WorkQueue | `aura.tasks.>` | 파이프라인·invoke 작업 |
| (없음) | Core | `aura.rpc.>` | Request-Reply (스트림에 넣지 않음) |
| (없음) | Core | `aura.stream.>` | UX 토큰/툴 진행 (유실 허용, JetStream 금지) |

스트림은 Fission MQT / task-bridge consumer 생성 **전에** 존재해야 한다. MQT·브리지 메타의 `stream`·`consumer`(pull)는 아래 표와 맞춘다.

### 3.2 태스크 (WorkQueue → MQT 또는 task-bridge)

| Subject | Consumer (예) | 함수 / 경로 | resp / error subject |
|---------|---------------|-------------|----------------------|
| `aura.tasks.agent.invoke` | `aura_task_bridge_agent` | **task-bridge** → `agent_invoke` | `aura.events.agent.invoke.done` / `aura.events.agent.invoke.error` |
| `aura.tasks.mcp.invoke` | `aura_task_bridge_mcp` | **task-bridge** → `mcp_invoke` | `aura.events.mcp.invoke.done` / `aura.events.mcp.invoke.error` |
| `aura.tasks.memory.capture` | `aura_memory_capture` | MQT → `memory_capture` | `aura.events.memory.candidates` / `aura.events.memory.capture.error` |
| `aura.tasks.memory.store` | `aura_memory_store` | MQT → `svc-memory` store | `aura.events.memory.stored` / `aura.events.memory.store.error` |
| `aura.tasks.memory.embed` | `aura_memory_embed` | MQT → `svc-memory` embed | `aura.events.memory.embedded` / `aura.events.memory.embed.error` |
| `aura.tasks.memory.consolidate` | `aura_memory_consolidate` | MQT → `svc-memory` consolidate | `aura.events.memory.consolidated` / `aura.events.memory.consolidate.error` |
| `aura.tasks.memory.ttl` | `aura_memory_ttl` | MQT → `svc-memory` ttl | `aura.events.memory.ttl.done` / `aura.events.memory.ttl.error` |
| `aura.tasks.memory.archive` | `aura_memory_archive` | MQT → `svc-memory` archive | `aura.events.memory.archived` / `aura.events.memory.archive.error` |
| `aura.tasks.memory.object_gc` | `aura_memory_object_gc` | MQT → `svc-memory` object_gc | `aura.events.memory.object_gc.done` / `aura.events.memory.object_gc.error` |

**MQT**(memory 등): `mqtype=nats-jetstream`, `mqtkind=keda`. `topic`은 위 subject, `metadata.stream`은 `AURA_TASKS`. **task-bridge**(agent/mcp): 언어별 MQT 금지 — [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md).

**MaxDeliver · DLQ (독약 메시지)**

| 규칙 | 내용 |
|------|------|
| `MaxDeliver` | WorkQueue consumer별 유한값(초안 **5**, DESIGN 확정). 초과 시 재전달 중단 |
| DLQ 스트림 | `AURA_DLQ` (Limits), subject `aura.dlq.>` — 원본 subject·마지막 오류·payload 메타 복사 |
| 적재 경로 | **① 함수/미들웨어 Term** — 마지막 delivery에서 `AURA_DLQ` 발행 후 `Term()`/`Ack`. JetStream 자동 이관 없음. **② Advisory 구독 비채택** |
| 격리 | poison이 워커 슬롯을 점유하며 재시도 루프하지 않음; `errorTopic`(MQT / task-bridge)과 병행·역할 분리 |
| 재처리 | 운영 Replay 도구(CLI/admin)만 — [`deploy/docs/dlq-replay.md`](deploy/docs/dlq-replay.md) · 자동 무한 replay 금지 |

### 3.3 RPC (Core Request-Reply — 상시 워밍)

`aura.rpc.>` 는 **스트림에 넣지 않는다**. 응답자는 NATS queue group 구독으로 HA한다. **KEDA JetStream MQT로 깨우지 않는다.**

| Subject | 요청자 | NATS 구독 | Fission Function | Warm |
|---------|--------|-----------|------------------|------|
| `aura.rpc.memory.recall` | `agent_invoke` | `aura-nats-rpc-bridge` (queue `aura-rpc-bridge`) | `aura-memory-recall` | bridge ≥2 · sync poolmgr `poolsize ≥ 2` |
| `aura.rpc.mcp.tool` | `agent_invoke` | 동일 브리지 | `aura-mcp-invoke-rpc` | 동일 |
| `aura.rpc.control.resolve` | agent/mcp Function | 동일 브리지 | `aura-control-resolve` | 동일 |

스케일 아웃(상한)은 sync poolmgr / Function concurrency·requestsPerPod 및 브리지 HPA로 한다. JetStream lag scaler를 RPC 경로에 연결하지 않는다. 매니페스트: [`deploy/k8s/nats-rpc-bridge/`](deploy/k8s/nats-rpc-bridge/) · [`deploy/k8s/runtime-envs/`](deploy/k8s/runtime-envs/).

RPC 타임아웃·페이로드 상한(기본 256KB)은 구현 시 `DESIGN.md`에 수치를 적는다. 초과 본문은 object store `content_ref`만 실는다(제품·스키마: [`deploy/docs/object-store-content-ref.md`](deploy/docs/object-store-content-ref.md)).

### 3.4 이벤트 (Limits)

| Subject | 발행 | 의미 |
|---------|------|------|
| `aura.events.memory.candidates` | `memory_capture` | store 입력 후보 |
| `aura.events.memory.stored` | `svc-memory` | item 적재 완료 |
| `aura.events.memory.embedded` | `svc-memory` | 인덱스 갱신 완료 |
| `aura.events.memory.consolidated` | `svc-memory` | 승격/dedupe 완료 |
| `aura.events.agent.invoke.done` | `agent_invoke` | 턴 완료 감사(정본) |

### 3.5 실시간 스트림 (Core — UX)

대화형 턴은 태스크 수락 시 `run_id`(UUIDv7)를 할당한다. `agent_invoke`는 실행 중 아래 subject로 publish한다.

| Subject | 발행 | 구독 | 의미 |
|---------|------|------|------|
| `aura.stream.<run_id>` | `agent_invoke` | Gateway(→클라이언트 SSE/WS) | 해당 런의 진행 프레임 |

**프레임 타입 (payload `type`)**

| `type` | 내용 |
|--------|------|
| `run.started` | `run_id`, `session_id`, `agent`, `version` |
| `token` | `text` (incremental; 슬림) |
| `tool.started` / `tool.finished` | `tool`, `server?`, `summary?` |
| `error` | 스트림상 오류 힌트(정본은 `aura.events.agent.invoke.error`) |
| `run.completed` | 스트림 종료 신호; **내구 완료는 반드시** `aura.events.agent.invoke.done` |

task-bridge·프레임·RPC 순서 고정: [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md) · [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) · 핸들러 [`services/agent-invoke/`](services/agent-invoke/).

규칙:

- JetStream/`AURA_EVENTS`에 토큰을 쌓지 않는다. 재연결 시 Gateway는 버퍼·replay를 보장하지 않는다(유실 허용). 필요 시 클라이언트는 done 이벤트·체크포인트로 최종 문구를 맞춘다.
- Gateway는 `run_id` 소유 principal만 구독하게 인가한다(토큰/세션 검증). subject 와일드카드 남용 금지.
- 비대화형·배치 전용 invoke는 스트림을 생략할 수 있으나, **대화형 기본 경로는 스트림 필수**.
- Gateway wire(`run_id` 발급 · SSE/WS · 인가): [`deploy/docs/gateway-sse-ws.md`](deploy/docs/gateway-sse-ws.md) · [`services/gateway/`](services/gateway/).

---

## 4. Fission / KEDA 실행 형태

두 계급을 섞지 않는다. (Core RR + scale-to-zero는 No Responders.)

### 4.1 비동기 — JetStream MQT (+ agent/mcp task-bridge)

- **대상(MQT)**: §3.2 `aura.tasks.*` 중 memory capture/store/embed/consolidate/ttl/archive 등 — MessageQueueTrigger `mqtype=nats-jetstream`, `mqtkind=keda`. 스트림·pull consumer 사전 생성. `resptopic` / `errortopic` + **MaxDeliver→DLQ**.
- **대상(task-bridge)**: `aura.tasks.agent.invoke` · `aura.tasks.mcp.invoke` — **`aura-nats-task-bridge`**가 JetStream pull 후 `runtime`→Function → Fission Router. 언어별 MQT 금지. Bridge **replicas≥2** + `void dispatchTaskMessage`/`TASK_MAX_INFLIGHT`(HOL 금지). Function 스케일=KEDA lag, **scale-to-zero 허용**. 상세: [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md).
- **스케일(MQT)**: KEDA JetStream lag. **`minReplicaCount = 0` 허용** (scale-to-zero).
- **콜드스타트 SLA (async만)**: 워밍 없이 p95 **< 15s** 베이스라인(M0 측정). 대화 턴의 **체감 지연 정본이 아님**.
- **M0 샘플**: Function/MQT `aura-tasks-smoke` — topic `aura.tasks.smoke`, pull consumer `aura_tasks_smoke`, `respTopic`=`aura.events.tasks.smoke.done`, `errorTopic`=`aura.events.tasks.smoke.error` (이름 정본은 `deploy/SETUP.md`).

### 4.2 동기 — Core Request-Reply + 공용 NATS→Fission 브리지

- **대상**: §3.3 `aura.rpc.*` (memory recall, mcp tool, control resolve).
- **NATS 구독**: Deployment **`aura-nats-rpc-bridge`** (replicas ≥ 2, queue-group `aura-rpc-bridge`). subject(+`runtime`)→Function 매핑 후 **Fission Router만** 호출·`msg.respond` 중계. **브리지 내부에서 도메인 handler 실행 금지.**
- **실행**: nodejs/python Sync Function은 런타임별 Environment **`aura-*-sync`** · executor **`poolmgr`** · **`poolsize ≥ 2`**. `runtime=custom`은 container executor · **`MinScale≥2`**. sync `newdeploy` MinScale 상주·서비스별 `*-rr` **금지**.
- **MQT·JetStream lag scaler 사용 금지** (RPC 경로).
- **이유**: Core RR 메시지는 스트림에 쌓이지 않아 KEDA가 0→1을 트리거할 수 없다 — 브리지와 sync 풀이 상시 Warm.
- **SLA (동기 연쇄)**: recall → resolve → mcp.tool 등 **동기 홉 합** p95 **< 1~2s** (콜드 제외, Warm 전제).
- **M0 smoke**: `deploy/dev`의 `aura-rpc-smoke-rr` 등은 **dev 하네스만** — 제품 경로에 포함하지 않는다.

### 4.3 공통

- 동일 논리 서비스(`svc-memory`)라도 **async Function**과 **sync Function**을 배포 단위로 분리한다. 메모리 **쓰기** 소유권은 여전히 `svc-memory` async 쪽만.
- Environment는 **nodejs/python × 계급 공용** (`aura-nodejs-async` / `aura-nodejs-sync` / `aura-python-async` / `aura-python-sync`). **`custom`은 공유 Environment가 아니라 container executor 이미지**다. **서비스별** Environment 금지.
- **비채택**: OpenFaaS. **폴백 없음**: bare Deployment+KEDA ScaledObject로 **MQT**를 대체하지 않는다. NATS→Function HTTP는 MQT connector·**공용 RPC/task 브리지**만 (Aura 서비스 간 임의 HTTP API 금지 — §1 #1 예외는 Router 중계).

---

## 5. 4유형 메모리와 파이프라인

Alibaba Cloud Agentic Memory 유형 모델을 따른다.

| `memory_type` | 질문 | 저장 요지 | 검색 |
|---------------|------|-----------|------|
| `short_term` | 지금 세션에서 무엇이 진행 중인가 | session 스코프, **월 파티션 TTL DROP**; **내구 HNSW 금지** | `session_id` 최근순(relational)만 |
| `episodic` | 어떤 상호작용·사건이 있었나 | run/시간 스코프 | 시간 필터 + vector + BM25 |
| `semantic` | 개념·관계는 무엇인가 | `memory_nodes` / `memory_edges` (+ embedding) | ego/k-hop + vector |
| `long_term` | 오래 참인 사실·선호 | durable item, Mem0식 CRUD | hybrid: vector + BM25 + scalar(scope) + graph 신호 |

**승격 규칙 (요약)** — 본문 [`deploy/docs/memory-consolidate-promotion.md`](deploy/docs/memory-consolidate-promotion.md)

- capture 후보는 기본적으로 `short_term` 또는 `episodic` 후보로 태깅한다.
- `aura.tasks.memory.consolidate`만 `short_term`→`episodic`→`long_term` / `semantic` 승격·병합·삭제(soft)를 수행한다.
- 허용 전이(M4 고정): `short_term`→`episodic` · `episodic`→`long_term` · `episodic`→`semantic`. 건너뛰기·역방향 금지.
- 유사도 점수만으로 `memory_type`을 바꾸지 않는다(`similarity_only` 거부). LIST 파티션이므로 in-place `UPDATE memory_type` 금지 — `soft_close` + `insert_promoted`(`supersedes_id`).
- `recurrence` 사유는 `evidence_count` **≥ 3**.

**파이프라인**

1. Agent 턴 종료(또는 중간 훅) → `aura.tasks.memory.capture`
2. `memory_capture` → `aura.events.memory.candidates` (PG 금지)
3. `svc-memory` → `aura.tasks.memory.store` → `embed`
4. 주기/임계 → `aura.tasks.memory.consolidate`
5. 다음 턴 전 → `aura.rpc.memory.recall` → Agent 컨텍스트 주입

---

## 6. PostgreSQL 스키마 (초안)

확장: `vector`(pgvector — 저장·`halfvec` 포함), `pg_trgm`(보조). BM25/전문 검색은 **stock `tsvector` + GIN + `ts_rank`/`ts_rank_cd`** 로 고정한다(ROADMAP 결정 로그 2026-11-18). ParadeDB/`pg_search`는 M1 비채택(품질 갭 실측 시 재평가). 아래 DDL의 `content_tsv` 경로가 정본이다.

**pgvector 인덱스 제약 (계약에 반영)**

- `vector`/`halfvec` **차원 미지정** 컬럼에 행을 넣는 것은 허용되나, 그 컬럼에 **직접** `USING hnsw` / `ivfflat` 를 걸면 `column does not have dimensions` 로 실패한다.
- `vector` HNSW 상한 **2000**차원. `halfvec` HNSW 상한 **4000**차원(메모리·디스크 약 1/2). Aura 인덱스 경로는 **`halfvec`만** 사용한다.
- 서로 다른 `(model, version)`·차원은 **한 HNSW 공간에서 비교하지 않는다**. recall은 활성 `model_key`만 질의한다.
- 멀티테넌트 공유 HNSW는 **pgvector ≥ 0.8** + `hnsw.iterative_scan` 없이 배포하지 않는다(§6.2.3).

### 6.1 쓰기 소유

| 테이블 | 쓰기 소유 |
|--------|-----------|
| `memory_items`, `memory_embeddings`, `memory_nodes`, `memory_edges`, `memory_audit` | **`svc-memory`만** |
| `source_meta`, `user_meta`, `control_audit` (DDL·resolve/admin wire: [`deploy/docs/svc-control-resolve.md`](deploy/docs/svc-control-resolve.md) · [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md) · [`deploy/sql/control_meta.sql`](deploy/sql/control_meta.sql)) | **`svc-control`만** |
| tenants/ACL (후속) | **`svc-control`만** |
| `agent_checkpoints` (DDL·소유: [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md) · [`deploy/sql/agent_checkpoints.sql`](deploy/sql/agent_checkpoints.sql)) | **`agent_invoke`만** (예외) |

### 6.1.1 컨트롤 메타 DDL (`source_meta` / `user_meta` / `control_audit`)

정본 DDL: [`deploy/sql/control_meta.sql`](deploy/sql/control_meta.sql). resolve: [`deploy/docs/svc-control-resolve.md`](deploy/docs/svc-control-resolve.md). 관리 HTTP·Admin UI: [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md) (MVP 스냅샷 [`admin-ui-mvp.md`](deploy/docs/admin-ui-mvp.md)).

**`source_meta` 불변 vs status:** `entrypoint`/`bundle_uri`/`checksum`/`sig_uri`/`config`/`runtime`/`kind`/`name`/`version` 은 INSERT 후 **UPDATE 금지**(새 version만). **`status`만** `pending→active`(activate)·`active→retired`(retire) 전이 UPDATE 허용. INSERT 초기값=`pending`. `config`에 `runtime` 키 금지.

**activate checksum:** 클라이언트 제출 checksum은 기대값. `POST …/activate` 시 `svc-control`이 Garage 객체를 읽어 sha256을 **서버에서** 계산·대조한 뒤에만 `pending→active`.

**Tenant picker (tenants 테이블 없음):** `DISTINCT source_meta.tenant_id` ∪ env `AURA_ADMIN_TENANT_IDS` ∪ UI UUID 직접 입력.

```sql
-- 요약 (FORCE RLS + set_config('app.tenant_id', $1, true) — §2.1)
CREATE TABLE source_meta (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  kind TEXT NOT NULL,          -- 'agent' | 'mcp'
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  entrypoint TEXT NOT NULL,    -- module.path:attr
  bundle_uri TEXT NOT NULL,    -- s3://aura-content/tenants/{tenant_id}/bundles/…
  checksum TEXT NOT NULL,
  sig_uri TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  runtime TEXT NOT NULL DEFAULT 'nodejs',  -- 'nodejs' | 'python' | 'custom' (func-env; not in cfg)
  status TEXT NOT NULL,        -- 'pending' | 'active' | 'retired'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, name, version)
);

CREATE TABLE user_meta (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  source_meta_id UUID NOT NULL REFERENCES source_meta(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  secrets_ref TEXT,            -- 참조만; plaintext 금지
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_meta_id, principal_id)
);

-- append-only audit (UPDATE/DELETE 앱 경로 금지)
CREATE TABLE control_audit (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

resolve 성공 응답 `type=control.resolve.done` 은 `source`(incl. `runtime`) + `user`(nullable) + `cfg`(1-depth merge, user wins) + `secrets_ref` + top-level **`runtime`**(=`source.runtime`) 을 담는다. `aura.rpc.control.resolve` 브리지 Warm(minReplicas ≥ 2): [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md) · `deploy/k8s/control-resolve/`. Pooler SELECT: [`services/control/pooler-lookup.js`](services/control/pooler-lookup.js).

### 6.1.2 런타임 체크포인트 DDL (`agent_checkpoints`)

정본 DDL: [`deploy/sql/agent_checkpoints.sql`](deploy/sql/agent_checkpoints.sql). 소유·`content_ref`/시크릿 규칙: [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md).

```sql
-- 요약 (FORCE RLS + set_config('app.tenant_id', $1, true) — §2.1)
-- Zero Direct Write 예외: agent_invoke만 INSERT (Pooler). memory_*/Gateway 쓰기 금지.
CREATE TABLE agent_checkpoints (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  run_id               TEXT NOT NULL,     -- Gateway UUIDv7
  session_id           TEXT NOT NULL,
  principal_id         TEXT NOT NULL,
  seq                  BIGINT NOT NULL,   -- UNIQUE (tenant_id, run_id, seq)
  parent_id            UUID,
  kind                 TEXT NOT NULL,     -- 'turn' | 'tool' | 'final'
  state_schema_version INTEGER NOT NULL DEFAULT 1,
  state                JSONB NOT NULL DEFAULT '{}',  -- 작은 재개 스냅샷; 시크릿 plaintext 금지
  content_ref          TEXT,              -- 대용량/PII → Object Store (§8)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

append-only. resume는 동일 `(tenant_id, run_id)`의 최대 `seq`(후속 구현). writer·TTL GC는 본 절 Non-goal.

### 6.2 메모리 DDL

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE memory_type AS ENUM (
  'short_term',
  'long_term',
  'episodic',
  'semantic'
);

-- memory_items: LIST(memory_type). short_term/episodic는 하위 RANGE(created_at 월)로 TTL DROP.
CREATE TABLE memory_items (
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  principal_id    TEXT,
  agent_id        TEXT,
  session_id      TEXT,
  run_id          TEXT,
  memory_type     memory_type NOT NULL,
  content         TEXT NOT NULL,
  content_tsv     tsvector GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(content, ''))
                  ) STORED,
  metadata        JSONB NOT NULL DEFAULT '{}',
  confidence      REAL,
  source_event_id UUID,
  supersedes_id   UUID,  -- 논리 참조(FK 없음). PK가 (id, memory_type, created_at)이라 UNIQUE(id) 불가
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, memory_type, created_at)
) PARTITION BY LIST (memory_type);
-- upsert: ON CONFLICT (id, memory_type, created_at). ON CONFLICT (id) 불가(파티션 UNIQUE는 파티션 키 포함 필수).
-- memory_items(id)만 가리키는 FK 금지 — 참조 테이블이 파티션 키를 갖지 않으면 생성 자체가 실패하고,
-- episodic 월 파티션 DROP도 inbound FK에 막힌다. item_id·supersedes_id는 앱 논리 참조.

-- CREATE TABLE memory_items_short_term PARTITION OF memory_items
--   FOR VALUES IN ('short_term') PARTITION BY RANGE (created_at);
-- CREATE TABLE memory_items_episodic PARTITION OF memory_items
--   FOR VALUES IN ('episodic') PARTITION BY RANGE (created_at);
-- CREATE TABLE memory_items_long_term PARTITION OF memory_items
--   FOR VALUES IN ('long_term');
-- CREATE TABLE memory_items_semantic PARTITION OF memory_items
--   FOR VALUES IN ('semantic');
-- 월 파티션 예: ... FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE INDEX idx_memory_items_scope
  ON memory_items (tenant_id, memory_type, session_id, created_at DESC);
CREATE INDEX idx_memory_items_tsv ON memory_items USING GIN (content_tsv);
CREATE INDEX idx_memory_items_metadata ON memory_items USING GIN (metadata);

-- 임베딩: 방안 B — LIST(model_key) + 파티션별 halfvec(N) HNSW.
-- short_term 행은 embed 금지(세션 최근순 recall만). episodic/long_term/semantic만 적재.
CREATE TABLE memory_embeddings (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  item_id      UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  memory_type  memory_type NOT NULL
                 CHECK (memory_type IN ('episodic', 'long_term', 'semantic')),
  model        TEXT NOT NULL,
  version      TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  dims         INT NOT NULL CHECK (dims > 0 AND dims <= 4000),
  embedding    halfvec NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, model_key),
  UNIQUE (item_id, model_key),
  CHECK (model_key = model || ':' || version)
) PARTITION BY LIST (model_key);

-- 활성 모델 파티션 + HNSW: ARCHITECTURE §6.2.1. 구형 모델 DETACH/DROP.
-- item 삭제·에피소딕 월 파티션 DROP 시 대응 embed 행도 배치로 정리(§6.2.2).

CREATE TABLE memory_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  entity_type  TEXT NOT NULL,
  name         TEXT NOT NULL,
  props        JSONB NOT NULL DEFAULT '{}',
  item_id      UUID,  -- 논리 참조 → memory_items.id (FK 없음; supersedes_id와 동일 이유)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, name)
);

CREATE TABLE memory_edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  source_node_id  UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target_node_id  UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  props           JSONB NOT NULL DEFAULT '{}',
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_node_id <> target_node_id)
);

-- 유효 엣지만(핫 경로). valid_until IS NULL = 현재 유효(또는 만료 없음).
CREATE INDEX idx_memory_edges_out
  ON memory_edges (tenant_id, source_node_id, relation_type)
  WHERE valid_until IS NULL;
CREATE INDEX idx_memory_edges_in
  ON memory_edges (tenant_id, target_node_id, relation_type)
  WHERE valid_until IS NULL;
-- 만료·이력 조회가 필요하면 별도 비스캔 인덱스(선택, M1 DESIGN).

CREATE TABLE memory_audit (
  id         UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  item_id    UUID,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- 월 파티션 생성·N개월 후 DROP. Soft delete 없음 — 파티션 단위 수명.
```

RLS: `tenant_id::text = current_setting('app.tenant_id', true)` (또는 동등)와 일치하는 행만. GUC는 **§1.4 / §2.1** 대로 트랜잭션마다 `set_config(..., true)`. 정책 SQL·롤 이름은 M1 `svc-memory` DESIGN에 둔다.

### 6.3 Hybrid recall

`aura.rpc.memory.recall` 요청(초안):

```json
{
  "tenant_id": "...",
  "principal_id": "...",
  "session_id": "...",
  "query": "...",
  "types": ["long_term", "semantic", "episodic", "short_term"],
  "top_k": 12
}
```

응답: RRF(또는 가중 합)로 병합한 item 목록. 단계:

1. scalar 필터: `tenant_id`, `valid_until IS NULL OR valid_until > now()`, 선택 `session_id`/`principal_id`; **유형별 파티션 프루닝**
2. `short_term`: HNSW 없이 세션 최근순만
3. vector: **활성 `model_key`만** + `memory_type IN ('episodic','long_term','semantic')` + **`tenant_id`를 같은 SQL WHERE에** — `(embedding::halfvec(N)) <=> …`. 혼비교 금지. 트랜잭션 시작 시 필수:
   ```sql
   SET LOCAL hnsw.iterative_scan = relaxed_order;  -- pgvector >= 0.8
   SET LOCAL hnsw.ef_search = 40;                  -- M1 고정 · deploy/docs/memory-embed-guard-iterative-scan.md
   SET LOCAL hnsw.max_scan_tuples = 20000;
   ```
   **앱 단 post-filter 금지.** 상세·폴백은 §6.2.3.
4. BM25: `content_tsv` (핫 파티션)
5. graph: `semantic` **방어적 1–2홉**(§6.2.4) — 벡터/BM25 시드 노드에서만 확장
6. 유형 예산: short_term 슬롯 / episodic / long_term+semantic 분리 — **Agent 주입 수치 고정** (아래 · [`deploy/docs/agent-inject-contract.md`](deploy/docs/agent-inject-contract.md))

Agent는 **이 recall 응답 `items[]`만** 메모리 컨텍스트에 넣는다. 원문 전량·PG 직접 SELECT·`content_ref` 우회 덤프 금지(§1 #9).

**Agent 주입 슬롯·토큰 예산 (M2 고정 · 패킹 구현=M3)**

| 슬롯 | 아이템 (default) | 토큰 상한 |
|------|------------------|-----------|
| short_term | **4** (`min(4, top_k)`) | **512** |
| episodic | hybrid 잔여 중 타입 분리 | **768** |
| long_term+semantic | hybrid 잔여 중 타입 분리 | **768** |
| **합계** | `top_k` default **12** | **2048** |

추정: `ceil(utf8_bytes/4)`. 슬롯 미사용분 재할당·spill 금지. 상세·절삭 규칙·Non-goals는 [`deploy/docs/agent-inject-contract.md`](deploy/docs/agent-inject-contract.md).

### 6.2.1 임베딩 파티션 운영 규칙

| 규칙 | 내용 |
|------|------|
| 저장 타입 | 부모 `embedding halfvec` (typemod 없음). 인덱스 경로만 `halfvec(N)` 캐스트 |
| 파티션 키 | `model_key = model \|\| ':' \|\| version` |
| 파티션당 인덱스 | 해당 `dims = N` CHECK + `hnsw ((embedding::halfvec(N)) halfvec_cosine_ops)` |
| **활성 핀 (M1)** | `AURA_EMBEDDING_MODEL=BAAI/bge-m3` · `version=1` · `dims=1024` · `model_key=BAAI/bge-m3:1` — [`deploy/docs/memory-embedding-active.md`](deploy/docs/memory-embedding-active.md) |
| 새 모델 | `ATTACH`/`CREATE PARTITION` + HNSW 생성 후 embed 워커의 active `model_key` 전환 |
| 폐기 | `DETACH PARTITION` → `DROP TABLE` (테이블 rewrite 없이 제거) |
| 금지 | 부모 테이블에 차원 없는 `hnsw(embedding)`; `vector` 타입 HNSW(2000 상한·용량); 다모델 단일 인덱스; **`short_term` embed** |
| 멀티테넌트 질의 | 공유 인덱스 + **`hnsw.iterative_scan`** (§6.2.3). 미검증 상태로 1만 유저 공유 금지 |

### 6.2.2 수명주기 · TTL · 아카이브

| 대상 | 파티션 | 핫 유지 | 제거/아카이브 |
|------|--------|---------|----------------|
| `short_term` items | LIST + **월 RANGE** | **14일** | **파티션 DROP** (DELETE+VACUUM 비선호). 내구 HNSW **미사용** |
| `episodic` items (+embeds) | LIST + **월 RANGE** | **24개월**(핫) | 콜드: `aura.tasks.memory.archive` → Object Storage **Parquet**(또는 동등) 적재 → **DETACH/DROP**. Soft `valid_until`만으로 방치 금지 |
| `long_term` / `semantic` | LIST (시간 RANGE는 연 단위 선택) | 장기 | `valid_until` + consolidate supersede; 대량 폐기는 배치 |
| `memory_audit` | **월 RANGE** | **12개월** | 오래된 월 파티션 **DROP** |
| `memory_embeddings` | LIST(`model_key`) | 활성 모델 | 모델 폐기 DETACH/DROP; 에피소딕 월 제거 시 orphan embed 정리 배치 |

**태스크**

- `aura.tasks.memory.ttl` — 만료 short_term/episodic/audit **월 파티션** DROP 스케줄 (MQT, scale-to-zero OK)
- `aura.tasks.memory.archive` — 콜드 episodic export(Parquet) → object store → DETACH/DROP; 완료 이벤트 `aura.events.memory.archived` — [`deploy/docs/memory-archive.md`](deploy/docs/memory-archive.md)
- `aura.tasks.memory.object_gc` — 유예(90일) 경과 미참조 `content_ref` 객체 삭제 배치 — [`deploy/docs/object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md)

**수치 (M1 고정 · 구현=M4)** — 본문 [`deploy/docs/memory-ttl-policy.md`](deploy/docs/memory-ttl-policy.md) · DROP job [`deploy/docs/memory-ttl-drop.md`](deploy/docs/memory-ttl-drop.md)

- short_term 핫: **14일** — DROP iff 파티션 상한 `U <= now() - interval '14 days'`
- episodic 핫: **24개월**; 이후 archive 대상
- audit 핫: **12개월**

`valid_until`은 논리 만료·승격용이다. **인덱스/디스크 회수는 파티션 DROP·아카이브가 정본**이다.

### 6.2.3 멀티테넌트 HNSW (post-filter 함정)

**문제.** 수백~수천 테넌트가 하나의 `model_key` HNSW를 공유할 때, ANN이 전역 이웃 K개만 모은 뒤 `tenant_id = $1`로 걸러내면, 행 수가 적은 테넌트는 K 안에 한 건도 없어 **Recall = 0**이 된다.

**기본 완화 (필수)** — 수치 본문 [`deploy/docs/memory-embed-guard-iterative-scan.md`](deploy/docs/memory-embed-guard-iterative-scan.md)

| 항목 | 계약 |
|------|------|
| pgvector | **≥ 0.8** (iterative_scan 지원) |
| 세션/트랜잭션 | 매 recall: `SET LOCAL hnsw.iterative_scan = relaxed_order`; `ef_search = **40**`; `max_scan_tuples = **20000**` |
| SQL | `WHERE tenant_id = $1 AND … ORDER BY embedding <=> $q LIMIT $k` — 필터와 ANN을 **한 쿼리**로 |
| 금지 | 전역 Top-K 결과 집합을 앱에서 테넌트 필터링 |
| short_term | `memory_embeddings` DDL CHECK + embed 앱 사전 거부로 **비적재**; recall은 최근순만 (§6.2.1·위 문서) |

**M1 검증 픽스처 (합격 조건)** — 본문 [`deploy/docs/memory-hnsw-multitenant-fixture.md`](deploy/docs/memory-hnsw-multitenant-fixture.md) · `smoke-memory-hnsw-multitenant.sh`

1. 대형 테넌트 A에 대량 embed, 소형 테넌트 B에 소수 embed(의도적으로 유사 벡터가 A에 더 많게).
2. B로 recall 시 **≥1건** 반환 (이상적으로 요청 top_k까지 B 행).
3. `iterative_scan` off 대조 시 B가 0건이 되는 경우를 회귀 테스트로 남긴다(함정 재현).

**승격 경로 (M1 검증 실패 또는 운영 KPI 미달 시 — 택일·병행)**

| 옵션 | 내용 |
|------|------|
| **T1** | `memory_embeddings`에 `tenant_bucket = hash(tenant_id) % N` 추가, **LIST/HASH 서브파티션** + 버킷별 HNSW (질의 시 버킷 프루닝) |
| **T2** | 초대형(“whale”) 테넌트는 **전용 파티션/인덱스** (`model_key` 또는 `tenant_id` 전용 자식 테이블) |
| **T3** | 테넌트 행 수 임계 미만이면 HNSW 대신 **exact/BRIN+필터** 또는 BM25 비중 상향 (DESIGN에 임계 기입) |

기본 배포는 **공유 `model_key` + iterative_scan**. T1/T2는 검증·SLO 실패 시에만 스키마를 확장한다(결정 로그에 기록).

### 6.2.4 그래프 순회 방어 (`memory_edges`)

**인덱스 (M1에 포함)**

| 인덱스 | 용도 |
|--------|------|
| `idx_memory_edges_out` `(tenant_id, source_node_id, relation_type) WHERE valid_until IS NULL` | 순방향 1홉 |
| `idx_memory_edges_in` `(tenant_id, target_node_id, relation_type) WHERE valid_until IS NULL` | **역방향** 1홉 |
| (선택) 만료 포함 btree | 감사·이력; recall 핫 경로 사용 금지 |

**유효 엣지 predicate (모든 순회 SQL)**

```sql
valid_from <= now()
AND (valid_until IS NULL OR valid_until > now())
```

핫 인덱스는 `valid_until IS NULL` partial과 맞춘다. 만료 임박 행은 배치가 `valid_until`을 설정해 핫 집합에서 제외한다.

**순회 한도 (M1 고정 · 구현=M4)** — 본문 [`deploy/docs/memory-graph-traversal.md`](deploy/docs/memory-graph-traversal.md)

| 가드 | 값 | 의미 |
|------|----|------|
| `max_depth` | **2** | 재귀/반복 상한. 3+ 금지 |
| `per_hop_limit` | **50** | 노드당 확장 엣지 상한(방향·relation 합산) |
| `max_nodes_total` | **100** | 한 recall 그래프 확장 노드 상한 |
| `max_edges_total` | **200** | 한 recall에서 읽는 엣지 상한 |
| `supernode_degree_cap` | **64** | 허브 노드 fan-out 캡 |
| `cycle` | visited set | 방문한 `node_id` 재확장 금지 |

**알고리즘 골격**

1. 시드: vector/BM25/아이템 → `memory_nodes` (소수).
2. depth 1..`max_depth`: frontier마다 out+in을 유효 predicate로 조회, 노드당 `per_hop_limit`, 슈퍼노드는 `supernode_degree_cap`.
3. `visited`에 없으면 추가; `max_nodes_total` / `max_edges_total`이면 중단.
4. 결과를 recall RRF 후보에 합류(가중치는 DESIGN).

**금지:** `WITH RECURSIVE` 무제한; `target_node_id` 풀스캔; 테넌트 가드 없는 조인; depth>2.

---

## 7. 런타임 invoke / 번들 형태

참고(계승 아님): agent-runtime의 pool·factory 아이디어.

**태스크 payload (`aura.tasks.agent.invoke`)** — 식별자만:

```json
{
  "run_id": "<uuidv7>",
  "agent": "name",
  "version": "1.2.3",
  "input": {},
  "session_id": "...",
  "stream": true,
  "principal": { "id": "...", "tenant_id": "..." }
}
```

`run_id`는 Gateway(또는 제출자)가 발급한다. `stream: true`(대화형 기본)면 실행 중 `aura.stream.<run_id>`에 프레임을 낸다. 클라이언트는 태스크 publish 직후 같은 `run_id`로 Gateway SSE/WS를 연다.

**MCP (`aura.tasks.mcp.invoke` / `aura.rpc.mcp.tool`)**:

```json
{
  "server": "name",
  "version": "1.2.3",
  "tool": "tool_name",
  "arguments": {},
  "principal": { "id": "...", "tenant_id": "..." }
}
```

Function은 `aura.rpc.control.resolve` 브리지로 `source_meta`+`user_meta`를 받고 `factory(cfg, secrets)`를 호출한다. 메타 쓰기는 `svc-control`만. 시크릿 취급은 §9.2. wire·DDL: [`deploy/docs/svc-control-resolve.md`](deploy/docs/svc-control-resolve.md). 브리지 Warm: [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md). MCP MQT·RPC: [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) · 외부 Streamable HTTP: [`deploy/docs/mcp-streamable-http.md`](deploy/docs/mcp-streamable-http.md) · [`services/mcp-invoke/`](services/mcp-invoke/).

**실행 격리:** 테넌트 커스텀/비신뢰 번들은 §9.1 샌드박스(`gvisor`/`kata`)에서만 로드한다. 플랫폼 서명 번들도 Egress NetworkPolicy는 동일하게 적용한다. 정책: [`deploy/docs/mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md).

---

## 8. 이벤트 JSON 공통 envelope

```json
{
  "id": "<uuidv7>",
  "type": "memory.candidates",
  "tenant_id": "...",
  "occurred_at": "2026-11-17T00:00:00Z",
  "payload": {},
  "content_ref": null
}
```

`id`는 멱등 키. NATS 페이로드 **256KB(262144) 초과** 또는 PII 본문은 **`content_ref`만** 넣고 `payload`에 원문을 두지 않는다(§9.3).

**Object Store 제품 (M2 / V2.1 · M4 경로 봉인):** **Garage** (S3-compatible / SigV4). 앱 버킷 **`aura-content` 단일** — prefix `tenants/{tenant_id}/refs/…` · `archive/…` · `bundles/…` 공유(용도별 버킷 분리 금지). PG Barman은 **`aura-pg` 별도 버킷·자격증명**. `content_ref` JSON·권한·암호화(`enc.kid`) 정본: [`deploy/docs/object-store-content-ref.md`](deploy/docs/object-store-content-ref.md). 라이브 provision은 그 문서 Non-goals.

**고아 객체 GC (M2 / V2.2 · 구현=M4):** `aura.tasks.memory.object_gc` — `refs/` prefix만, 객체 age **≥ 90일**(`AURA_EVENTS` retention 정합)이고 PG live 참조가 없을 때만 `DeleteObject`. 참조 존재 시 **스킵**. 알고리즘·멱등 키·배치: [`deploy/docs/object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md).

---

## 9. 보안 · 비용 · 컴플라이언스 (엔터프라이즈)

### 9.1 멀티테넌트 코드 격리

| 규칙 | 내용 |
|------|------|
| 신뢰 경계 | 테넌트가 올린 커스텀 agent/mcp 번들은 **비신뢰 코드** |
| 런타임 | **M3 기본 RuntimeClass=`gvisor`(`runsc`)**. 고위험 티어=`kata`(또는 동등). factory 로드·실행은 샌드박스에서만. 동일 노드 풀 공유 시에도 커널/네임스페이스 격리 |
| 네트워크 | Pod **Egress NetworkPolicy deny-default**; allowlist = NATS·Pooler·**LLM Gateway**·허용 object store(`aura-content`)·**등록된 MCP 호스트**·클러스터 DNS |
| 격리 강화 | 고위험(`risk_tier=high`)은 **RuntimeClass=`kata` + 전용 노드풀** (`aura.sandbox/pool=kata` label · `NoSchedule` taint · RuntimeClass `scheduling`). standard는 `gvisor`만 · Kata 풀 점유 금지 |
| 플랫폼 번들 | 서명·checksum 검증 필수. 미서명 커스텀은 샌드박스 없이 금지. **서명 번들도 Egress NP는 동일** |

정책 정본(이름·allowlist·차등): [`deploy/docs/mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md).  
고위험 전용 RuntimeClass/노드풀(M5): [`deploy/docs/high-risk-tenant-nodepool.md`](deploy/docs/high-risk-tenant-nodepool.md) · `check-high-risk-tenant-nodepool.sh`.  
Egress 차단 검증(NP 매니페스트·앱 allowlist 스모크): [`deploy/docs/egress-block-verify.md`](deploy/docs/egress-block-verify.md) · `deploy/k8s/sandbox-egress/`. CNI FQDN/egress-proxy 라이브 프로브는 후속.

### 9.2 시크릿 전송 · 캐시

| 규칙 | 내용 |
|------|------|
| 전송 | NATS 클러스터·클라이언트 **mTLS** 필수(출시 전). resolve 응답의 시크릿은 암호화 채널만 |
| 로그/트레이스 | API 키·토큰·`secrets` 필드 **마스킹**; OTel attribute 허용 목록; 스팬에 `aura.tenant_id`/`aura.session_id`/`aura.run_id` 필수 |
| 프로세스 캐시 | Function 메모리 캐시 **TTL 짧음**(초안 ≤ 60s) + **키 로테이션/revoke 이벤트** 시 무효화(`aura.events.control.secrets.rotated`) |
| 금지 | 시크릿을 `AURA_EVENTS`·DLQ·스트림 프레임·OTel attribute에 기록 |

M3 와이어(오버레이·mask/cache/tls 가드·체크): [`deploy/docs/nats-mtls-secrets.md`](deploy/docs/nats-mtls-secrets.md) · `deploy/k8s/nats-mtls/` · `check-nats-mtls-secrets.sh`. live cert 발급·시크릿 스토어 본구현은 후속.

M3 최소 경로·NATS mTLS overlay·마스킹/TTL 캐시: [`deploy/docs/nats-mtls-secrets.md`](deploy/docs/nats-mtls-secrets.md) · `deploy/k8s/nats-mtls/` · [`services/control/`](services/control/) (`secrets-mask.js` · `secrets-cache.js` · `nats-tls.js`) · `check-nats-mtls-secrets.sh`. live cert apply·Vault 본구현은 후속.


M4 OTel (Function·NATS·PG) attribute allowlist + 상관 ID + `maskSecrets` 재사용: [`deploy/docs/otel-function-nats-pg.md`](deploy/docs/otel-function-nats-pg.md) · [`services/otel/`](services/otel/) · `check-otel-function-nats-pg.sh`. live Collector/OTLP CI 필수는 Non-goal.

### 9.3 GDPR · 잊힐 권리

| 규칙 | 내용 |
|------|------|
| 핫 경로 | 대화/메모리 본문은 가능하면 **`content_ref` + 객체 암호화**; 이벤트 payload 최소화 |
| 삭제 | 사용자/테넌트 탈퇴 → **crypto-shredding**(데이터 암호화 키 파기) + PG 파티션/행 삭제 배치 + object 삭제 |
| `AURA_EVENTS` 90일 | 보관 중에도 PII 원문 최소화. 키 파기 후 잔존 ciphertext는 복호 불가 |
| `memory_audit` | 무기한 원문 금지 — 요약/해시·ref만 또는 TTL 파티션(§6.2.2)과 정합 |
| 작업 | `aura.tasks.compliance.erase` (MQT) — M4 초안: OpenBao Transit DEK shred → 핫 PG redact → `refs/` Delete · [`deploy/docs/compliance-erase.md`](deploy/docs/compliance-erase.md) · [`services/compliance/`](services/compliance/) · `check-compliance-erase.sh` (live KMS/M5 운영화=후속) |

### 9.4 중앙 LLM Gateway

| 규칙 | 내용 |
|------|------|
| 범위 | **모델 서빙(가중치 호스팅)은 여전히 범위 밖**. Aura Function은 공급자 API를 **직접 호출하지 않고** 클러스터 내 **LLM Gateway**만 호출 |
| 기능 | 테넌트/플랜 **Rate limit**, **Fallback 모델**, **Circuit Breaker**, **토큰·비용 로깅**(과금·이상 탐지) |
| 적용 | `agent_invoke`, `memory_capture`, consolidate 등 모든 LLM 호출 |
| 배포 | `services/llm-gateway` (또는 동등 관리형). Egress Policy의 유일한 LLM 출구. 최소 와이어: [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md) · `deploy/k8s/llm-gateway/` · `check-llm-gateway.sh` |

M3 최소 경로·Function 클라이언트 egress 가드: [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md) · `deploy/k8s/llm-gateway/` · `check-llm-gateway.sh`.  
M5 Fallback + 테넌트 과금 대시보드: [`deploy/docs/llm-gateway-fallback-billing.md`](deploy/docs/llm-gateway-fallback-billing.md) · `check-llm-gateway-fallback-billing.sh`. live provider 배선 고도화는 후속.

### 9.5 콜드스타트 · Warm Pool SLA

| 경로 | 목표 |
|------|------|
| async MQT 콜드 | p95 < **15s** (M0 베이스라인, 백그라운드 허용) |
| sync RPC Warm Pool | 단일 홉 p95 ≪ 1s; **연쇄(resolve+recall+mcp) p95 < 1~2s** |
| 대화 턴 체감 | 첫 `token` 프레임까지 — DESIGN SLO(동기 Warm + LLM TTFB). async agent 콜드가  crit path에 있으면 **minReplicas≥1** 또는 프리워으로 완화 |

### 9.6 PostgreSQL HA / DR

| 항목 | 계약 |
|------|------|
| 토폴로지 | **Multi-AZ** 단일 논리 클러스터(CNPG/동등). “디스크 1장” 단일 장애점 금지 |
| Read | recall·읽기 많은 경로 **Read Replica** 오프로드 가능(쓰기 `svc-memory`는 primary). 앱은 **RO Pooler**만 — `-ro` Service 직접 연결 금지(§2.1) |
| 백업 | **PITR** 연속 백업(Barman Cloud object store). **RPO ≤ 5m · RTO ≤ 1h** — 토폴로지 [`deploy/docs/pg-ha-pitr-topology.md`](deploy/docs/pg-ha-pitr-topology.md). **M4 확정**(lab drill #1 충족) [`deploy/docs/pg-pitr-drill.md`](deploy/docs/pg-pitr-drill.md) · `check-pg-pitr-drill.sh` |
| 훈련 | 정기 복구 드릴(**분기 1회 이상**) + 스택변경 후 ≤14일 — 캘린더 [`deploy/docs/pg-pitr-drill-calendar.md`](deploy/docs/pg-pitr-drill-calendar.md) · `check-pg-pitr-drill-calendar.sh`. M4 lab-1=2026-Q4 시드; cluster(CNPG/Barman) 선호·lab 허용 |

### 9.7 DLQ · Poison Pill

§3.2 MaxDeliver + `AURA_DLQ`(적재=**① Term**) + Replay 도구([`deploy/docs/dlq-replay.md`](deploy/docs/dlq-replay.md) · `check-dlq-replay.sh`). 모니터링: DLQ depth 알림. 자동 replay 루프·Advisory 이관 금지.

---

## 10. 범위 밖 (초기)

LLM **가중치 서빙**/vLLM 운영, 사용자 Chat UI 풀스택, 헬프데스크 티켓 FSM, path-graph/VFS 통째 이식.

**NATS Account 격리**는 출시 후 검토. **Fair Queue(§2.2)·LLM Gateway(§9.4)·샌드박스(§9.1)·mTLS·GDPR erase·PG HA·DLQ**는 출시 전 범위다.
