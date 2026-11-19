# Aura deploy setup (M0 bootstrap)

로컬/개발 클러스터에 **NATS JetStream · KEDA · Fission**을 올린다. 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md) §3–§4, 일정은 [ROADMAP.md](../ROADMAP.md) M0.

**이 문서 범위:** 컨트롤 플레인 설치·스모크 + JetStream 스트림 사전 생성 + async/sync 분리(V0.1) + async MQT echo + V0.3 poison→errorTopic + V0.2 sync Core RR + **V0.4 `AURA_DLQ` ① Term**.  
**후속:** Fission MQT Term 미들웨어 이식 · async 콜드 p95.  
**M1 PG+Pooler:** 제품=CloudNativePG `Pooler`([docs/pg-pooler-smoke-plan.md](docs/pg-pooler-smoke-plan.md) · [`k8s/pg-pooler`](k8s/pg-pooler/)) — `install-pg-pooler.sh` / `check-pg-pooler.sh` / **V1.1** `smoke-pg-pooler.sh`(+ `rls-smoke-fixture.sql`).  
**M1 PG HA 초안:** [docs/pg-ha-pitr-topology.md](docs/pg-ha-pitr-topology.md) · `k8s/pg-pooler/cluster-ha.draft.yaml` · `check-pg-ha.sh` — **RPO ≤ 5m · RTO ≤ 1h**. **M4 드릴(확정):** [docs/pg-pitr-drill.md](docs/pg-pitr-drill.md) · `check-pg-pitr-drill.sh` · lab-1 실측 충족(CNPG/Barman 스케일=M5).

## 전제

| 항목 | 값 |
|------|-----|
| Kubernetes | ≥ 1.32 (Fission 1.27) |
| Helm | v3+ (`kubectl` 포함) |
| 클러스터 권한 | cluster-admin (CRD·NS 생성) |
| 핀 버전 | NATS image `nats:2.10-alpine` · KEDA chart `2.20.2` · Fission `1.27.0` |

KEDA는 Fission 1.27이 빌드·검증한 **2.20.x**를 쓴다(2.21로 올리지 말 것).  
[Compatibility](https://fission.io/docs/installation/compatibility/).

## 한 방에 설치 + 스모크

```bash
bash deploy/scripts/install-runtime.sh
bash deploy/scripts/smoke-runtime.sh
bash deploy/scripts/smoke-streams.sh
bash deploy/scripts/apply-split-deploy.sh
bash deploy/scripts/smoke-split-deploy.sh
bash deploy/scripts/smoke-async-mqt.sh
bash deploy/scripts/smoke-async-poison.sh
bash deploy/scripts/smoke-sync-rpc.sh
```

| 단계 | 구현 |
|------|------|
| NATS JetStream + monitor `:8222` | Kustomize [`deploy/k8s/base`](k8s/base/) → ns `aura`, NodePort `30422`/`30822` |
| KEDA | Helm `kedacore/keda` `2.20.2` → ns `keda` |
| Fission | CRDs(`kubectl create` 또는 **server-side apply**) + Helm `fission-charts/fission-all` `1.27.0`, **`mqt_keda.enabled=true`**, **`internalAuth.enabled=false`** (stock KEDA connector는 HMAC 미서명 → router-internal 401) → ns `fission` |
| Streams | `ensure-streams.sh` (nats-box) — `AURA_TASKS` WorkQueue · `AURA_EVENTS` Limits 90d · `AURA_DLQ` Limits |
| Split deploy (V0.1) | [`k8s/async-smoke`](k8s/async-smoke/) MQT `minReplicaCount=0` · [`k8s/sync-smoke`](k8s/sync-smoke/) `newdeploy` `MinScale≥2` (MQT/ScaledObject 없음) |
| Async echo | Package `echo.js` · topic `aura.tasks.smoke` → `respTopic`/`errorTopic` · `smoke-async-mqt.sh` |
| Async poison (V0.3) | `maxRetries`→`errorTopic` + consumer `MaxDeliver=5` · `ensure-async-consumer.sh` · `smoke-async-poison.sh` |
| Sync Core RR (V0.2) | Deployment `aura-rpc-smoke-rr` replicas≥2 · subject `aura.rpc.smoke` · queue `aura-rpc-smoke` · `smoke-sync-rpc.sh` |

Fission CRD OpenAPI가 커서 client-side `kubectl apply`의 `last-applied-configuration` 한도(262144)에 걸릴 수 있다. `install-runtime.sh`는 create 실패 시 `--server-side --force-conflicts`로 재시도한다.

## 분리 배포 이름 (V0.1)

두 계급을 **별 디렉터리·별 라벨**로 둔다. 동일 Deployment/Function에 scale-to-zero(0)와 Warm(≥2)을 섞지 않는다.

| 계급 | 경로 | Function | 스케일 | 라벨 |
|------|------|----------|--------|------|
| async MQT | `deploy/k8s/async-smoke/` | `aura-tasks-smoke` | MQT `minReplicaCount=0` (Fission가 KEDA ScaledObject 생성) | `aura.runtime/class=async` |
| sync Warm | `deploy/k8s/sync-smoke/` | `aura-rpc-smoke` (+ RR `aura-rpc-smoke-rr`) | Function `newdeploy` `MinScale=2` · **Core RR Deployment replicas≥2** (§4.3) | `aura.runtime/class=sync` |

| 이름 | 값 | 비고 |
|------|-----|------|
| pull consumer | `aura_tasks_smoke` | MQT `metadata.consumer` · stream `AURA_TASKS` · topic `aura.tasks.smoke` |
| resp / error | `aura.events.tasks.smoke.done` / `aura.events.tasks.smoke.error` | MQT `respTopic` / `errorTopic` |
| DLQ subject | `aura.dlq.tasks.dlq_term_smoke` (스모크) / `aura.dlq.tasks.smoke` (예약) | 적재 경로 **① Term** (`smoke-dlq-term.sh`); Advisory 비채택 |
| MaxDeliver | `5` | durable `aura_tasks_smoke` — `ensure-async-consumer.sh` (V0.3) |
| RPC subject | `aura.rpc.smoke` | Core Request-Reply — **스트림/MQT 없음** |
| RPC queue-group | `aura-rpc-smoke` | Deployment `aura-rpc-smoke-rr` 기동 시 `nats reply -q` |
| RPC responder | `aura-rpc-smoke-rr` | replicas **≥2**; body `{type:rpc.smoke.done,echo:Request}` |

정적 게이트(클러스터 불필요) + 클러스터 관측:

```bash
bash deploy/scripts/check-split-deploy.sh   # MQT 이름표 + echo.js == Package literal
bash deploy/scripts/apply-split-deploy.sh
bash deploy/scripts/smoke-split-deploy.sh
bash deploy/scripts/smoke-async-mqt.sh      # live: pub → done / fail → error
bash deploy/scripts/smoke-async-poison.sh   # V0.3: fail+bad JSON → errorTopic; MaxDeliver; settle
bash deploy/scripts/smoke-sync-rpc.sh       # V0.2: Core RR Warm + scale-0 No Responders
bash deploy/scripts/smoke-dlq-term.sh       # V0.4: MaxDeliver → Term → AURA_DLQ (path ①)
```

`aura.tasks.smoke` echo: 성공 JSON은 `aura.events.tasks.smoke.done`에 `{id,type:tasks.smoke.done,echo}`; `{"aura_smoke":"fail"}` 또는 잘못된 JSON은 MQT `maxRetries` 후 `aura.events.tasks.smoke.error`에 잔존하고 consumer는 settle(acks/redelivered/unprocessed=0).  
`aura.rpc.smoke` Core RR: Warm 응답 `{type:rpc.smoke.done,echo}`; responders `replicas=0`이면 즉시 No Responders.  
`AURA_DLQ` 적재: **① handler Term** (`smoke-dlq-term.sh`); JetStream 자동 이관·Advisory(②) 아님.

## 엔드포인트 (클러스터)

| 용도 | 주소 |
|------|------|
| NATS client | `nats://nats.aura.svc.cluster.local:4222` (호스트 NodePort `30422`) |
| NATS monitor (`/jsz`, KEDA scaler) | `nats.aura.svc.cluster.local:8222` (호스트 `30822`) |
| Fission | ns `fission` (router/executor/storagesvc/`mqtrigger-keda`) |

후속 MQT metadata 예:

- `natsServer=nats://nats.aura.svc.cluster.local:4222`
- `natsServerMonitoringEndpoint=nats.aura.svc.cluster.local:8222`

## 스모크 합격 기준

`smoke-runtime.sh` exit 0:

- `aura/nats` StatefulSet Ready, `/healthz`·`/jsz` OK
- `keda` operator·metrics-apiserver Ready, `scaledobjects.keda.sh` CRD
- `fission` router·executor·storagesvc·**mqtrigger-keda** Ready

`smoke-streams.sh` exit 0 (ARCHITECTURE §3):

| 스트림 | retention | subjects |
|--------|-----------|----------|
| `AURA_TASKS` | WorkQueue | `aura.tasks.>` |
| `AURA_EVENTS` | Limits, max-age 90d | `aura.events.>` |
| `AURA_DLQ` | Limits | `aura.dlq.>` |

스트림만 재생성·검증:

```bash
bash deploy/scripts/ensure-streams.sh   # idempotent
bash deploy/scripts/smoke-streams.sh
```

### Async MQT echo (`aura.tasks.smoke`)

```bash
bash deploy/scripts/apply-split-deploy.sh   # (재)적용 — Package literal = echo.js
bash deploy/scripts/smoke-async-mqt.sh      # publish → resptopic echo
```

| 항목 | 값 |
|------|-----|
| 본문 | `deploy/k8s/async-smoke/echo.js` — request body echo (2xx → `respTopic`) |
| in | `aura.tasks.smoke` (`AURA_TASKS`) |
| out | `aura.events.tasks.smoke.done` (`AURA_EVENTS`) |
| error | `aura.events.tasks.smoke.error` |

### Async poison / V0.3 (`errortopic` 우선)

```bash
bash deploy/scripts/ensure-async-consumer.sh   # consumer MaxDeliver=5
bash deploy/scripts/smoke-async-poison.sh      # bad JSON + fail → errorTopic; settle
```

| 항목 | 값 |
|------|-----|
| JetStream | consumer `aura_tasks_smoke` **MaxDeliver=5** (무한 재전달 금지) |
| MQT | `maxRetries: 3` 후 `errorTopic` |
| 증거 | `aura.events.tasks.smoke.error` 잔존 + consumer unprocessed/acks=0 |
| `AURA_DLQ` | V0.3 슬라이스에서는 **미적재가 정상** (errorTopic 잔존만). 적재는 V0.4 |

### `AURA_DLQ` Term / V0.4 (path ①)

```bash
bash deploy/scripts/smoke-dlq-term.sh      # MaxDeliver → Term → aura.dlq.>
```

| 항목 | 값 |
|------|-----|
| 경로 | **①** 마지막 delivery에서 payload 확보 → `AURA_DLQ` publish → `Term()` |
| 비채택 | ② Advisory 구독 이관 · JetStream 자동 이관 |
| 스모크 subject | `aura.tasks.dlq_term_smoke` → `aura.dlq.tasks.dlq_term_smoke` |
| consumer | 전용 durable `aura_dlq_term_smoke` (MQT `aura_tasks_smoke` 비침범) |
| errorTopic | V0.3과 **병행·비충돌** (본 스모크는 errorTopic 미사용) |

### Sync Core RR / V0.2 (`aura.rpc.smoke`)

```bash
bash deploy/scripts/apply-split-deploy.sh   # includes aura-rpc-smoke-rr
bash deploy/scripts/smoke-sync-rpc.sh       # Warm RR · scale-0 No Responders · HA
```

| 항목 | 값 |
|------|-----|
| 응답자 | Deployment `aura-rpc-smoke-rr` (nats-box `nats reply -q aura-rpc-smoke`) |
| subject / queue | `aura.rpc.smoke` / `aura-rpc-smoke` |
| Warm | replicas **≥2**; 응답 `{type:rpc.smoke.done,echo:<request>}` |
| 회귀 | replicas→0 → **No Responders**; 복구 후 RR 재성공 |
| Fission Function | `aura-rpc-smoke` newdeploy MinScale≥2 — Warm Pool 불변(V0.1); NATS 구독은 Deployment |
| MQT / lag | **미연결** |

**하지 않음(후속):** Fission MQT에 Term 미들웨어 이식(프로덕션 consumer).

### PG + Pooler / V1.1 (`set_config` + RLS)

```bash
bash deploy/scripts/install-pg-pooler.sh   # CNPG operator + aura-pg + Pooler
bash deploy/scripts/check-pg-pooler.sh     # static: transaction + pooler-only DSN
SMOKE_PG_POOLER_STATIC=1 bash deploy/scripts/smoke-pg-pooler.sh  # (d) + fixture gate
bash deploy/scripts/smoke-pg-pooler.sh     # live (a)–(c) via aura-pg-pooler Service
```

| 항목 | 값 |
|------|-----|
| 픽스처 | `deploy/k8s/pg-pooler/rls-smoke-fixture.sql` (`FORCE ROW LEVEL SECURITY`) |
| 테넌트 GUC | 매 트랜잭션 `SELECT set_config('app.tenant_id', $1, true)` |
| 합격 | 풀 재사용 후 타 테넌트 미노출; `set_config(..., false)` 경로 없음 |

### memory_items 파티션 + RLS (M1)

```bash
bash deploy/scripts/check-memory-items.sh              # static: LIST + RANGE parents + FORCE RLS
SMOKE_MEMORY_ITEMS_STATIC=1 bash deploy/scripts/smoke-memory-items.sh
bash deploy/scripts/smoke-memory-items.sh              # live via pooler: seed months + RLS
```

| 항목 | 값 |
|------|-----|
| DDL | `deploy/sql/memory_items.sql` — LIST(`memory_type`); short_term/episodic → 월 RANGE; long_term/semantic 리프 |
| RLS | `FORCE` + `tenant_id::text = current_setting('app.tenant_id', true)` |
| 시드 월 | smoke가 UTC prev/current/next 월 파티션 ATTACH |
| TTL | 핫/DROP 수치 = [`docs/memory-ttl-policy.md`](docs/memory-ttl-policy.md) · job = [`docs/memory-ttl-drop.md`](docs/memory-ttl-drop.md) |
| Non-goals | embeddings · `svc-memory` store 본문 · live DROP 스모크(클러스터 적용 시) |

### memory_audit 월 RANGE + RLS (M1)

```bash
bash deploy/scripts/check-memory-audit.sh              # static: RANGE(created_at) + FORCE RLS
SMOKE_MEMORY_AUDIT_STATIC=1 bash deploy/scripts/smoke-memory-audit.sh
bash deploy/scripts/smoke-memory-audit.sh              # live via pooler: seed months + RLS
```

| 항목 | 값 |
|------|-----|
| DDL | `deploy/sql/memory_audit.sql` — `PARTITION BY RANGE (created_at)`; PK `(id, created_at)` |
| RLS | `FORCE` + `tenant_id::text = current_setting('app.tenant_id', true)` |
| 시드 월 | smoke가 UTC prev/current/next 월 파티션 ATTACH |
| TTL | audit 핫 **12개월** — [`docs/memory-ttl-policy.md`](docs/memory-ttl-policy.md) · DROP [`docs/memory-ttl-drop.md`](docs/memory-ttl-drop.md) |
| Non-goals | soft delete · `memory_items` FK · embeddings · `svc-memory` store 본문 |

### memory_nodes / memory_edges + RLS + edge indexes (M1)

```bash
bash deploy/scripts/check-memory-nodes-edges.sh              # static: tables + FORCE RLS + out/in indexes
bash deploy/scripts/check-memory-graph-traversal.sh          # static: partial indexes + 순회 한도 DESIGN
bash deploy/scripts/check-memory-graph-supernode.sh        # static: hub ≫ cap → bounded walk (no cluster)
SMOKE_MEMORY_NODES_EDGES_STATIC=1 bash deploy/scripts/smoke-memory-nodes-edges.sh
bash deploy/scripts/smoke-memory-nodes-edges.sh              # live via pooler: RLS + indexes
```

| 항목 | 값 |
|------|-----|
| DDL | `deploy/sql/memory_nodes_edges.sql` — nodes UNIQUE(tenant,type,name); edges FK→nodes + self-loop CHECK; `idx_memory_edges_out`/`in` partial(`valid_until IS NULL`) |
| RLS | `FORCE` + `tenant_id::text = current_setting('app.tenant_id', true)` (양 테이블) |
| 순회 한도·walk | [`docs/memory-graph-traversal.md`](docs/memory-graph-traversal.md) · `services/memory/recall/graph-walk.js` (M4) |
| 슈퍼노드 픽스처 | [`docs/memory-graph-supernode-fixture.md`](docs/memory-graph-supernode-fixture.md) · `check-memory-graph-supernode.sh` |
| Non-goals | embeddings · live apply |

### memory_embeddings LIST(model_key) + halfvec HNSW (M1)

```bash
bash deploy/scripts/check-memory-embeddings.sh              # static: LIST + undimensioned halfvec + generation DESIGN
SMOKE_MEMORY_EMBEDDINGS_STATIC=1 bash deploy/scripts/smoke-memory-embeddings.sh
bash deploy/scripts/smoke-memory-embeddings.sh              # live via pooler: fixture ATTACH → switch → DETACH
```

| 항목 | 값 |
|------|-----|
| DDL | `deploy/sql/memory_embeddings.sql` — LIST(`model_key`); 부모 `halfvec` (typemod 없음); `memory_type` CHECK로 short_term 제외 |
| RLS | `FORCE` + `tenant_id::text = current_setting('app.tenant_id', true)` |
| 세대 교체 | [`docs/memory-embeddings-generation.md`](docs/memory-embeddings-generation.md) — ATTACH → active 전환 → DETACH |
| 활성 핀 | [`docs/memory-embedding-active.md`](docs/memory-embedding-active.md) — `BAAI/bge-m3` / `1` / `1024` · `check-memory-embedding-active.sh` |
| 스모크 | fixture `fixture:v1`/`v2` · dims=3 only (≠ production `AURA_EMBEDDING_*`); Cluster에 pgvector 필요 |
| Non-goals | TEI 매니페스트 · HF digest 핀 · HNSW 왜곡 픽스처 · `svc-memory` store |

### short_term embed 가드 + iterative_scan / ef_search (M1)

```bash
bash deploy/scripts/check-memory-embed-guard.sh              # static: DDL CHECK + DESIGN numbers
SMOKE_MEMORY_EMBED_GUARD_STATIC=1 bash deploy/scripts/smoke-memory-embed-guard.sh
bash deploy/scripts/smoke-memory-embed-guard.sh              # live via pooler: short_term reject + undim HNSW fail + GUCs
```

| 항목 | 값 |
|------|-----|
| 문서 | [`docs/memory-embed-guard-iterative-scan.md`](docs/memory-embed-guard-iterative-scan.md) |
| DDL | `memory_embeddings.memory_type` CHECK — `short_term` 제외 |
| GUC | `iterative_scan=relaxed_order` · `ef_search=40` · `max_scan_tuples=20000` · pgvector **≥0.8** |
| Non-goals | 생산 dims · store/recall 본구현 (왜곡 픽스처는 아래) |

### 멀티테넌트 HNSW 왜곡 픽스처 (M1)

```bash
bash deploy/scripts/check-memory-hnsw-multitenant.sh              # static: DESIGN A/B · ON≥1/OFF · T1/T2
SMOKE_MEMORY_HNSW_MT_STATIC=1 bash deploy/scripts/smoke-memory-hnsw-multitenant.sh
bash deploy/scripts/smoke-memory-hnsw-multitenant.sh              # live via pooler: A=2000 B=2 L2 · OFF=0 · ON≥1
```

| 항목 | 값 |
|------|-----|
| 문서 | [`docs/memory-hnsw-multitenant-fixture.md`](docs/memory-hnsw-multitenant-fixture.md) |
| 픽스처 | `hnsw_mt_fixture` · dims=3 · **halfvec_l2** · A=2000 · B=2 · `LIMIT 10` |
| 합격 | ON(`relaxed_order`) B≥1 · OFF B=0; 실패 시 T1/T2(§6.2.3) |
| 갭 | 생산 cosine 왜곡 ON 미달 → 재실측/T1/T2 후보 (스키마 미적용) |
| Non-goals | 생산 dims · T1/T2 스키마 구현 · `svc-memory` store · cosine→L2 교체 |

### 활성 AURA_EMBEDDING_* 핀 (M1 · TEI/store 비범위)

```bash
bash deploy/scripts/check-memory-embedding-active.sh   # doc gate: BAAI/bge-m3 · version=1 · dims=1024
```

| 항목 | M1 고정 |
|------|---------|
| 문서 | [`docs/memory-embedding-active.md`](docs/memory-embedding-active.md) |
| MODEL / VERSION / DIMS | `BAAI/bge-m3` / `1` / `1024` (`model_key=BAAI/bge-m3:1`) |
| TTL | [`docs/memory-ttl-policy.md`](docs/memory-ttl-policy.md) (14d/24mo/12mo · 재고정 아님) |

### svc-memory store MQT (M1 · `set_config(..., true)`)

```bash
bash deploy/scripts/check-memory-store.sh   # DESIGN + MQT + withTenantTx selftests (no cluster)
```

| 항목 | 값 |
|------|-----|
| DESIGN | [`../services/memory/DESIGN.md`](../services/memory/DESIGN.md) |
| 코드 | `services/memory/store/tenant-tx.js` · `handler.js` |
| 매니페스트 | [`k8s/memory-store/`](k8s/memory-store/) — topic `aura.tasks.memory.store` · consumer `aura_memory_store` · resp/error `aura.events.memory.stored` / `.store.error` · `minReplicaCount=0` |
| 테넌트 GUC | 매 트랜잭션 `SELECT set_config('app.tenant_id', $1, true)` (`is_local=true`); `false`/세션 `SET` 금지 |
| Non-goals | embed/recall/consolidate 본구현 · TEI · live apply 필수 · 실 `memory_items` UPSERT(동일 헬퍼 위 후속) |

### memory_capture MQT (M2 · PG 금지)

```bash
bash deploy/scripts/check-memory-capture.sh   # DESIGN + MQT + PG-forbidden selftest (no cluster)
```

| 항목 | 값 |
|------|-----|
| DESIGN | [`../services/memory-capture/DESIGN.md`](../services/memory-capture/DESIGN.md) |
| 코드 | `services/memory-capture/handler.js` |
| 매니페스트 | [`k8s/memory-capture/`](k8s/memory-capture/) — topic `aura.tasks.memory.capture` · consumer `aura_memory_capture` · resp/error `aura.events.memory.candidates` / `.capture.error` · `minReplicaCount=0` |
| PG | **금지** — Pooler DSN/`set_config`/`query` 미사용 |
| Non-goals | 라이브 LLM Gateway · `content_ref` Object Store 업로드 · live apply 필수 |

### svc-memory embed MQT (M2 · short_term 스킵)

```bash
bash deploy/scripts/check-memory-embed.sh   # DESIGN + MQT + short_term skip selftest (no cluster)
```

| 항목 | 값 |
|------|-----|
| DESIGN | [`../services/memory/DESIGN.md`](../services/memory/DESIGN.md) (Embed MQT 절) |
| 코드 | `services/memory/embed/handler.js` (+ `store/tenant-tx.js`) |
| 매니페스트 | [`k8s/memory-embed/`](k8s/memory-embed/) — topic `aura.tasks.memory.embed` · consumer `aura_memory_embed` · resp/error `aura.events.memory.embedded` / `.embed.error` · `minReplicaCount=0` |
| short_term | **스킵** — PG INSERT 미시도 (`skipped_short_term`) |
| embeddable | episodic/long_term/semantic → `set_config(..., true)` + 활성 `model_key` stub (HNSW); BM25=`content_tsv` |
| Non-goals | 라이브 TEI · 실 halfvec INSERT · hybrid RRF recall · live apply 필수 |

### svc-memory consolidate MQT (M4 · 유형 승격 규칙)

```bash
bash deploy/scripts/check-memory-consolidate.sh   # 승격 규칙 + similarity_only 금지 + MQT selftest (no cluster)
```

| 항목 | 값 |
|------|-----|
| 정책 | [`docs/memory-consolidate-promotion.md`](docs/memory-consolidate-promotion.md) |
| DESIGN | [`../services/memory/DESIGN.md`](../services/memory/DESIGN.md) (Consolidate MQT 절) |
| 코드 | `services/memory/consolidate/{promote,handler}.js` (+ `store/tenant-tx.js`) |
| 매니페스트 | [`k8s/memory-consolidate/`](k8s/memory-consolidate/) — topic `aura.tasks.memory.consolidate` · consumer `aura_memory_consolidate` · resp/error `aura.events.memory.consolidated` / `.consolidate.error` · `minReplicaCount=0` |
| 불변식 | consolidate만 유형 변경 · `similarity_only` 거부 · soft_close+insert_promoted (no `UPDATE memory_type`) |
| Non-goals | LLM extract 본문 · graph write · 실 UPSERT · ttl/archive · live apply 필수 |

### svc-memory recall RPC (M2 · Warm Pool · hybrid RRF)

```bash
bash deploy/scripts/check-memory-recall.sh   # DESIGN + hybrid RRF + GUCs + Core RR deploy (no cluster)
```

| 항목 | 값 |
|------|-----|
| DESIGN | [`../services/memory/DESIGN.md`](../services/memory/DESIGN.md) (Recall RPC 절) |
| 코드 | `services/memory/recall/handler.js` (`mode: hybrid_rrf` · short_term 최근순 + BM25/vector RRF + graph walk) · `graph-walk.js` |
| 매니페스트 | [`k8s/memory-recall/`](k8s/memory-recall/) — Function `aura-memory-recall` `newdeploy` **MinScale≥2** · Deployment `aura-memory-recall-rr` **replicas≥2** · subject `aura.rpc.memory.recall` · queue-group `aura-memory-recall` |
| GUC | Pooler + `set_config(..., true)` · `SET LOCAL hnsw.iterative_scan/ef_search/max_scan_tuples` |
| 금지 | MessageQueueTrigger · JetStream lag ScaledObject · 앱 post-filter |
| 슈퍼노드 | [`docs/memory-graph-supernode-fixture.md`](docs/memory-graph-supernode-fixture.md) |
| Non-goals | 라이브 TEI · live apply 필수 |

### Agent 주입 계약 (M2 수치 고정 · 패킹 비범위)

```bash
bash deploy/scripts/check-agent-inject-contract.sh   # doc gate: slots + 2048/512/768/768 + recall-only
```

| 항목 | M2 고정 |
|------|---------|
| 문서 | [`docs/agent-inject-contract.md`](docs/agent-inject-contract.md) |
| 소스 | `aura.rpc.memory.recall` `items[]`만 · 원문/`content_ref` 덤프 금지 |
| 토큰 | 합 **2048** · short_term **512** · episodic **768** · long_term+semantic **768** |
| 아이템 | short_term **4** · `top_k` **12** |
| 구현 | 패킹=`agent_invoke` M3 (`services/agent-invoke` · `packRecallItems`) |

### `agent_invoke` MQT · 스트림 프레임 (M3)

```bash
bash deploy/scripts/check-agent-invoke.sh   # DESIGN + MQT + stream frames + selftest (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/agent-invoke-mqt.md`](docs/agent-invoke-mqt.md) · [`../services/agent-invoke/DESIGN.md`](../services/agent-invoke/DESIGN.md) |
| topic / consumer | `aura.tasks.agent.invoke` / `aura_agent_invoke` |
| resp / error | `aura.events.agent.invoke.done` / `aura.events.agent.invoke.error` |
| 스트림 | Core `aura.stream.<run_id>` — `run.started` / `token` / `tool.*` / `run.completed` |
| RPC | resolve · recall · mcp.tool (injectable; live RR 후속) |
| 매니페스트 | `k8s/agent-invoke/` · `minReplicaCount=0` |
| Non-goals | Fair Queue · live LLM Gateway · live NATS Core publisher (Gateway SSE → 아래 절) |

### `agent_checkpoints` 예외 테이블 DDL (M3 · §6)

```bash
bash deploy/scripts/check-agent-checkpoints.sh   # DDL + FORCE RLS + ownership doc (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/agent-checkpoints.md`](docs/agent-checkpoints.md) · [`../services/agent-invoke/DESIGN.md`](../services/agent-invoke/DESIGN.md) |
| DDL | [`sql/agent_checkpoints.sql`](sql/agent_checkpoints.sql) — FORCE RLS · UNIQUE`(tenant_id, run_id, seq)` · kind `turn`/`tool`/`final` |
| 쓰기 | **`agent_invoke`만** (Zero Direct Write 예외) · Pooler + `set_config(..., true)` |
| Non-goals | Pooler writer 본구현 · resume API · TTL/partition GC · 라이브 apply 필수 |

### `aura.rpc.control.resolve` 브리지 · Warm Core RR (M3)

```bash
bash deploy/scripts/check-control-resolve-bridge.sh   # DESIGN + Warm≥2 + RR Deployment + selftest (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/control-resolve-bridge.md`](docs/control-resolve-bridge.md) · [`../services/control/DESIGN.md`](../services/control/DESIGN.md) · wire [`docs/svc-control-resolve.md`](docs/svc-control-resolve.md) |
| sync | `aura.rpc.control.resolve` · queue `aura-control-resolve` · **MinScale≥2** + Deployment `aura-control-resolve-rr` **replicas≥2** |
| 매니페스트 | `k8s/control-resolve/` (Warm + RR; **MQT 없음**) |
| PG | 의도=Pooler + `set_config(..., true)` · **라이브 SELECT 배선 Non-goal** (injectable) |
| Non-goals | HTTP admin · live Pooler client · sandbox egress |

### `aura.rpc.control.resolve` 브리지 (M3 · Warm Core RR)

```bash
bash deploy/scripts/check-control-resolve-bridge.sh   # DESIGN + Warm≥2 + bridge selftest (no cluster)
bash deploy/scripts/check-svc-control-resolve.sh      # DDL + resolve wire (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/control-resolve-bridge.md`](docs/control-resolve-bridge.md) · [`docs/svc-control-resolve.md`](docs/svc-control-resolve.md) · [`../services/control/DESIGN.md`](../services/control/DESIGN.md) |
| sync | `aura.rpc.control.resolve` · queue `aura-control-resolve` · **MinScale≥2** + Deployment `aura-control-resolve-rr` **replicas≥2** |
| 매니페스트 | [`k8s/control-resolve/`](k8s/control-resolve/) — **MQT 없음** |
| handler | `services/control/bridge.js` — stub / injectable lookup |
| PG | Pooler + `set_config(..., true)` **의도만** (라이브 SELECT Non-goal) |
| Non-goals | HTTP admin 본구현 · live Pooler 배선 · tenants/ACL |

### `mcp_invoke` 이원화 · MQT + RPC (M3)

```bash
bash deploy/scripts/check-mcp-invoke-dual.sh   # DESIGN + MQT + RPC Warm≥2 + selftest (no cluster)
bash deploy/scripts/check-mcp-streamable-http.sh   # Streamable HTTP adapter + selftest (no live network)
bash deploy/scripts/check-mcp-bundle-isolation.sh  # RuntimeClass/Egress/서명 정책 (doc-only)
bash deploy/scripts/check-egress-block-verify.sh   # NP+RuntimeClass 매니페스트 + offline simulator (no live CNI)
bash deploy/scripts/check-llm-gateway.sh          # LLM Gateway 최소 + Function egress guard (no cluster)
bash deploy/scripts/check-llm-gateway-fallback-billing.sh  # Fallback 모델 + 테넌트 과금 대시보드 (no live provider)
bash deploy/scripts/check-nats-mtls-secrets.sh  # NATS mTLS overlay + secrets mask/TTL cache (no live cert)
bash deploy/scripts/check-otel-function-nats-pg.sh  # OTel Function·NATS·PG attrs + allowlist (no live collector)
bash deploy/scripts/check-compliance-erase.sh       # compliance.erase crypto-shred draft (no live OpenBao)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/mcp-invoke-dual.md`](docs/mcp-invoke-dual.md) · [`docs/mcp-streamable-http.md`](docs/mcp-streamable-http.md) · [`docs/mcp-bundle-isolation.md`](docs/mcp-bundle-isolation.md) · [`docs/egress-block-verify.md`](docs/egress-block-verify.md) · [`docs/llm-gateway.md`](docs/llm-gateway.md) · [`docs/nats-mtls-secrets.md`](docs/nats-mtls-secrets.md) · [`docs/otel-function-nats-pg.md`](docs/otel-function-nats-pg.md) · [`../services/mcp-invoke/DESIGN.md`](../services/mcp-invoke/DESIGN.md) · [`../services/llm-gateway/DESIGN.md`](../services/llm-gateway/DESIGN.md) · [`../services/otel/DESIGN.md`](../services/otel/DESIGN.md) |
| async | `aura.tasks.mcp.invoke` / `aura_mcp_invoke` → `aura.events.mcp.invoke.done`/`error` |
| sync | `aura.rpc.mcp.tool` · queue `aura-mcp-invoke` · **MinScale≥2** + Deployment `aura-mcp-invoke-rr` **replicas≥2** |
| 매니페스트 | `k8s/mcp-invoke/` (MQT) · `k8s/mcp-invoke-rpc/` (Warm + RR; **MQT 없음**) · `k8s/sandbox-egress/` (NP + RuntimeClass) · `k8s/llm-gateway/` (Deployment≥2) |
| PG | **금지** (Zero Direct Write) |
| 격리 | RuntimeClass 기본=`gvisor` · Egress deny-default allowlist · 서명 vs 커스텀 ([`docs/mcp-bundle-isolation.md`](docs/mcp-bundle-isolation.md)) · 차단 검증 ([`docs/egress-block-verify.md`](docs/egress-block-verify.md)) |
| LLM | Function → `aura-llm-gateway`만 ([`docs/llm-gateway.md`](docs/llm-gateway.md) · `check-llm-gateway.sh`) · M5 Fallback/과금 [`docs/llm-gateway-fallback-billing.md`](docs/llm-gateway-fallback-billing.md) · `check-llm-gateway-fallback-billing.sh` |
| NATS TLS | overlay [`k8s/nats-mtls/`](k8s/nats-mtls/) · mask/TTL [`docs/nats-mtls-secrets.md`](docs/nats-mtls-secrets.md) · `check-nats-mtls-secrets.sh` |
| OTel (M4) | Function·NATS·PG attrs + mask [`docs/otel-function-nats-pg.md`](docs/otel-function-nats-pg.md) · `check-otel-function-nats-pg.sh` · [`../services/otel/`](../services/otel/) |
| erase (M4) | crypto-shred + content_ref [`docs/compliance-erase.md`](docs/compliance-erase.md) · `check-compliance-erase.sh` · [`../services/compliance/`](../services/compliance/) · `k8s/compliance-erase/` |
| Non-goals | CNI FQDN/egress-proxy **라이브 프로브** · live provider 키 CI · SPA 과금 UI · live NATS SDK · full MCP initialize (Streamable HTTP client: `streamable-http.js`) · **live cert apply CI 필수** (mTLS 매니페스트·selftest만) · **OTel Collector live apply CI 필수** |

### Gateway · `run_id` · SSE/WS · principal (M3)

```bash
bash deploy/scripts/check-gateway-sse-ws.sh   # DESIGN + Deployment≥2 + principal/SSE selftest (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/gateway-sse-ws.md`](docs/gateway-sse-ws.md) · [`../services/gateway/DESIGN.md`](../services/gateway/DESIGN.md) |
| 제출 | `POST /v1/agent/invoke` → UUIDv7 `run_id` → `aura.tasks.agent.invoke` |
| 브리지 | SSE `GET /v1/runs/:run_id/events` · WS `…/ws` · exact `aura.stream.<run_id>` |
| 인가 | 소유 principal만 · 403/404 · 와일드카드 구독 금지 |
| 매니페스트 | `k8s/gateway/` Deployment **replicas≥2** · Service · **MQT 없음** · **PG 없음** |
| Non-goals (SSE 슬라이스) | live NATS SDK · live LLM Gateway (Fair Queue는 아래 절) |

### Gateway · Fair Queue / Rate Limit (M3 · §2.2)

```bash
bash deploy/scripts/check-gateway-fair-queue.sh   # Token Bucket + max_inflight + noisy fixture (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/gateway-fair-queue.md`](docs/gateway-fair-queue.md) |
| 알고리즘 | Token Bucket + `max_inflight` · 키=`tenant_id` |
| 기본 수치 | rate **10**/s · burst **30** · inflight **20** |
| 거부 | **429** (`rate_limited` / `max_inflight_exceeded`) · JetStream 미적재 |
| 상태 | CAS KV `quota.{tenant_id}` (memory 테스트 · NATS KV 권장) |
| Non-goals | live NATS KV 클라이언트 · live done 구독 Deployment · F1 샤딩 |

### Gateway · inflight `release` + bypass re-check (M3 · §2.2)

```bash
bash deploy/scripts/check-gateway-inflight-release.sh   # terminal release + ensureAdmitted poison (no cluster)
```

| 항목 | M3 고정 |
|------|---------|
| 문서 | [`docs/gateway-inflight-release.md`](docs/gateway-inflight-release.md) |
| 감산 | stream `run.completed`/`error` · event `aura.events.agent.invoke.done`/`error` |
| 우회 | `agent_invoke` `ensureAdmitted` → 429 poison · 재큐 금지 |

### Object Store · `content_ref` (M2 / V2.1 · provision 비범위)

```bash
bash deploy/scripts/check-object-store-content-ref.sh   # doc gate: Garage + 256KB ref-only + schema
bash deploy/scripts/check-object-store-orphan-gc.sh  # 90d + object_gc MQT ([docs/memory-object-gc.md](docs/memory-object-gc.md))     # doc gate: 90d orphan GC + object_gc + skip-if-ref
bash deploy/scripts/check-compliance-erase.sh          # OpenBao Transit crypto-shred + refs/ erase draft
```

| 항목 | M2 고정 |
|------|---------|
| 문서 | [`docs/object-store-content-ref.md`](docs/object-store-content-ref.md) · [`docs/object-store-orphan-gc.md`](docs/object-store-orphan-gc.md) |
| 제품 | **Garage** (S3-compatible / SigV4); NCP/AWS는 endpoint 스왑 |
| 버킷 | **`aura-content` 단일** — `refs/` · `archive/` · `bundles/` prefix 공유; Barman=`aura-pg` 분리 |
| 규칙 | >256KB 또는 PII → `content_ref` only · public ACL 금지 · `enc.kid` |
| 고아 GC | grace **90일** · `aura.tasks.memory.object_gc` · live 참조 시 스킵 (구현=M4) |
| erase 초안 | KMS=**OpenBao Transit** · [`docs/compliance-erase.md`](docs/compliance-erase.md) · `check-compliance-erase.sh` · shred→PG redact→`refs/` Delete |
| Non-goals | 라이브 provision · SDK 업로드 · live OpenBao destroy CI |

### memory TTL 정책 + 월 파티션 DROP (M1 수치 · M4 job)

```bash
bash deploy/scripts/check-memory-ttl.sh       # 14d/24mo/12mo + DROP MQT + needs_archive + selftests
bash deploy/scripts/check-memory-archive.sh   # Parquet → DETACH/DROP + MQT
```

| 항목 | 고정 |
|------|------|
| 수치 | [`docs/memory-ttl-policy.md`](docs/memory-ttl-policy.md) — short **14일** · epi **24개월** · audit **12개월** · 일 1회 |
| M4 DROP | [`docs/memory-ttl-drop.md`](docs/memory-ttl-drop.md) · `services/memory/ttl/` · `k8s/memory-ttl/` |
| short_term / audit | 만료 월 파티션 **DROP RESTRICT** |
| episodic | 콜드 → `needs_archive` (archive 후 DROP) |
| 태스크 | `aura.tasks.memory.ttl` / consumer `aura_memory_ttl` |

### PG Multi-AZ / PITR (M1 초안 · apply 비범위)

```bash
bash deploy/scripts/check-pg-ha.sh          # draft shape + RPO/RTO doc gate (no cluster)
bash deploy/scripts/check-pg-pitr-drill.sh  # M4 drill runbook + restore draft (no Barman)
SMOKE_PITR_STATIC=1 bash deploy/scripts/smoke-pg-pitr-drill.sh
```

| 항목 | M1 초안 |
|------|---------|
| 토폴로지 | CNPG `instances≥3` + zone anti-affinity — [`docs/pg-ha-pitr-topology.md`](docs/pg-ha-pitr-topology.md) |
| 참고 매니페스트 | `k8s/pg-pooler/cluster-ha.draft.yaml` (**kustomization 미포함**; 값 채운 뒤 별도 apply) |
| **RPO** | **≤ 5분** (연속 WAL archive 전제) |
| **RTO** | **≤ 1시간** (페일오버 또는 PITR 신규 Cluster+DSN 전환) |
| recall | 옵트인 `aura-pg-pooler-ro` (`type: ro`); store는 RW Pooler only |
| 실측 | M4 lab-1 완료 — [`docs/pg-pitr-drill.md`](docs/pg-pitr-drill.md) · restore draft `cluster-pitr-restore.draft.yaml` · 선택 재측정 `run-pg-pitr-lab-drill.sh` · CNPG 라이브=`AURA_PITR_LIVE=1` (M5) |

## 제거 (개발 클러스터만)

```bash
helm uninstall fission -n fission || true
helm uninstall keda -n keda || true
kubectl delete -k deploy/k8s/base || true
# CRD·PVC는 필요 시 수동 삭제
```

## 참고

- Fission install: https://fission.io/docs/installation/
- Fission × KEDA MQT / NATS JetStream: https://fission.io/docs/usage/triggers/message-queue-trigger-kind-keda/nats-jetstream/
- Internal auth + KEDA gap: https://fission.io/docs/installation/internal-auth/ (`internalAuth.enabled=false` until signing-aware connectors)
