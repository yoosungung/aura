# svc-memory (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#5 · §2.1 · §3.2–§3.3 · §4.2 · §5 · §6.3.  
일정: [ROADMAP.md](../../ROADMAP.md) M1–M2 (store/embed 모듈 · recall hybrid RRF) · M4 (consolidate/ttl/archive/object_gc **CronJob** · graph walk).  
DDL: [`deploy/sql/`](../../deploy/sql/) · 활성 핀: [`deploy/docs/memory-embedding-active.md`](../../deploy/docs/memory-embedding-active.md) · 가드: [`deploy/docs/memory-embed-guard-iterative-scan.md`](../../deploy/docs/memory-embed-guard-iterative-scan.md) · 승격: [`deploy/docs/memory-consolidate-promotion.md`](../../deploy/docs/memory-consolidate-promotion.md) · 그래프: [`deploy/docs/memory-graph-traversal.md`](../../deploy/docs/memory-graph-traversal.md) · TTL: [`deploy/docs/memory-ttl-drop.md`](../../deploy/docs/memory-ttl-drop.md).

**이 문서 범위:** `svc-memory` **store**/ **embed** **모듈**(capture in-process) + **recall**(sync Deployment) + **consolidate**/ **ttl**/ **archive**/ **object_gc**(**CronJob one-shot** · `aura/memory-batch` · 상시 Deployment 없음).  
하드코드 런북: [`deploy/docs/memory-control-hardcode.md`](../../deploy/docs/memory-control-hardcode.md) (`erase≠object_gc`).  
캡처 통합: [`memory-capture-inline-pipeline.md`](../../deploy/docs/memory-capture-inline-pipeline.md).  
**Non-goals (본 슬라이스):** LLM extract 본문 · 실 `halfvec` UPSERT · recall query 자동 embed · 파드→Ollama/TEI **직접** · live Pooler DSN/sqlx 본배선(RecordingClient 단위 경로만) · live 클러스터 apply 필수(정적 게이트만) · `WITH RECURSIVE`.

수치·모델 발명 금지 — 생산 임베딩은 이미 `BAAI/bge-m3:1` 핀. store는 `memory_items` INSERT/UPSERT; embed는 Gateway `/v1/embeddings`. 단독 store/embed Deployment **퇴역**.

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-memory` **store 모듈**만 `memory_*` 쓰기 경계 (§1 #5) — capture가 in-process 호출 |
| 실행 계급 (쓰기·배치) | capture=`aura/memory-capture` Deployment · 배치=`aura/memory-batch` **CronJob only**(상시 파드 없음) |
| 실행 계급 (recall) | **sync** Deployment replicas=1 · NATS는 **공용 `aura-nats-rpc-bridge`** → Service HTTP · **MQT 없음** |
| PG | **CloudNativePG Pooler**만 — host `aura-pg-pooler…` (`AURA_DATABASE_HOST`). primary/Pod IP 금지. recall 읽기는 **RO Pooler** 가능(§9.6) |
| 테넌트 GUC | 매 트랜잭션 시작: `SELECT set_config('app.tenant_id', $1, true)` (SELECT 경로 포함) |
| 금지 | `set_config(..., false)` · 세션 `SET app.tenant_id` · 트랜잭션 밖 테넌트 상태 의존 · **`short_term` embed INSERT** · **recall에 MessageQueueTrigger / JetStream lag ScaledObject** |

---

## Store 모듈 (Deployment 퇴역)

코드: `services/memory/src/store.rs` · `handle_store_request` · capture in-process.  
단독 topic `aura.tasks.memory.store` / `deploy/k8s/memory-store` Deployment **제거**.

| 항목 | 규칙 |
|------|------|
| GUC | `with_tenant_tx` → `set_config('app.tenant_id', $1, true)` 만 |
| 쓰기 | `INSERT INTO memory_items … ON CONFLICT (id, memory_type, created_at) DO UPDATE` |
| 본문 | `content` 인라인 **또는** `content_ref`→`metadata.content_ref` (빈 content 허용) |
| tsv | `content_tsv` GENERATED — INSERT 컬럼 목록에 **넣지 않음** |
| 멱등 | 동일 `(id, memory_type, created_at)` 재배달 → UPSERT |
| 클라이언트 | 단위=`RecordingClient` · live Pooler/sqlx=후속 |
| 금지 | stub `SELECT` 쓰기 경로 · capture 파일 내 SQL |

---

## Embed 모듈 (Deployment 퇴역)

코드: `services/memory` `embed_plan` / `handle_embed_request` · Gateway embeddings (sqlx 후속).  
단독 topic `aura.tasks.memory.embed` / `deploy/k8s/memory-embed` Deployment **제거**.  

| `memory_type` | 동작 |
|---------------|------|
| `short_term` | **스킵** — HTTP 2xx `payload.status=skipped_short_term`; PG/`set_config`/INSERT **미시도** (DDL CHECK + 앱 이중 가드) |
| `episodic` / `long_term` / `semantic` | Gateway `POST /v1/embeddings` → dims 검증 → `withTenantTx` stub · HNSW 의도; BM25는 store `content_tsv` GIN 적격 (`indexes.hnsw/bm25=true`, `via=llm_gateway`) |
| 기타 | 400 `memory_type_not_embeddable` |

활성 핀(기본=env 또는 M1 고정): `AURA_EMBEDDING_MODEL` / `VERSION` / `DIMS` → `model_key=model:version`.  
Gateway: `AURA_LLM_GATEWAY_URL`(기본 `http://aura-llm-gateway.aura.svc.cluster.local:8080`)만. 벡터 길이 ≠ dims → 400 `embedding_dims_mismatch`. Gateway 실패 → 502 `embed_provider_error`.  
입력: §8 + `payload.memory_type` · `payload.item_id` · (선택) `content`. 성공 본문 `type: memory.embedded` · `payload.status=accepted`.

---

## Capture Deployment (§3.2 · inline pipeline)

계획: [`deploy/docs/memory-capture-inline-pipeline.md`](../../deploy/docs/memory-capture-inline-pipeline.md).  
코드: `src/capture.rs` · bin `src/bin/aura-memory-capture.rs`.  
이미지: **`aura/memory-capture`** (`Dockerfile.capture`) — batch 바이너리 **미포함**.

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.capture` |
| consumer | `aura_memory_capture` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.capture.done` |
| errorTopic | `aura.events.memory.capture.error` |
| image | `aura/memory-capture` |
| replicas | **1** (lab) |
| 매니페스트 | [`deploy/k8s/memory-capture/`](../../deploy/k8s/memory-capture/) |

한 프로세스에서 extract → embed(Gateway) → store(모듈) **순차** (NATS store/embed hop **없음**).  
입력: §8 envelope (`id` · `tenant_id` · `payload.text`|`messages`).  
성공: `type: memory.capture.done` · `payload.{candidates,embedded,stored}`.  
금지: capture 파일에 SQL 인라인 · 캡처 이미지에 consolidate/ttl/archive/object_gc · Fission MQT.

---

## Object GC CronJob (§3.2 · §8 · M4)

| 필드 | 값 |
|------|-----|
| task id | `aura.tasks.memory.object_gc` (식별용 · JetStream durable **아님**) |
| 실행 | **CronJob** `aura-memory-object-gc-cron` → `/aura-memory-object-gc` (`aura/memory-batch`) |
| 이벤트 | `aura.events.memory.object_gc.done` / `.error` (handler publish) |
| 매니페스트 | [`deploy/k8s/memory-object-gc/`](../../deploy/k8s/memory-object-gc/) · **deployment 없음** |

**정본:** [`object-store-orphan-gc.md`](../../deploy/docs/object-store-orphan-gc.md) · 구현 [`memory-object-gc.md`](../../deploy/docs/memory-object-gc.md)

| 항목 | 규칙 |
|------|------|
| 대상 | `aura-content` · `tenants/{tenant}/refs/` only · grace **90일** · batch **100** |
| 스킵 | PG `metadata.content_ref` live hit · young · archive/bundles |
| GUC | `withTenantTx` → `set_config(..., true)` |
| 멱등 | `object-gc:{tenant}:{yyyy-mm-dd}` · DeleteObject 404=OK |

성공 본문 `type: memory.object_gc.done`.

## Archive CronJob (§3.2 · §6.2.2 · §8 · M4)

| 필드 | 값 |
|------|-----|
| task id | `aura.tasks.memory.archive` (식별용 · JetStream durable **아님**) |
| 실행 | **CronJob** `aura-memory-archive-cron` → `/aura-memory-archive` (`aura/memory-batch`) |
| 이벤트 | `aura.events.memory.archived` / `.error` |
| 매니페스트 | [`deploy/k8s/memory-archive/`](../../deploy/k8s/memory-archive/) · **deployment 없음** |

**정본:** [`deploy/docs/memory-archive.md`](../../deploy/docs/memory-archive.md) · 경로 [`object-store-content-ref.md`](../../deploy/docs/object-store-content-ref.md)

| 항목 | 규칙 |
|------|------|
| 대상 | 콜드 `memory_items_episodic_YYYY_MM` only |
| 순서 | export → PutObject(`aura-content`/`archive/episodic/…`) → verify → DETACH → DROP RESTRICT |
| 금지 | Put 전 DROP · CASCADE · Soft-delete-only · 비-episodic 이름 |

성공 본문 `type: memory.archived`. TTL `needs_archive` 핸드오프.

## TTL CronJob (§3.2 · §6.2.2 · M4)

| 필드 | 값 |
|------|-----|
| task id | `aura.tasks.memory.ttl` (식별용 · JetStream durable **아님**) |
| 실행 | **CronJob** `aura-memory-ttl-cron` → `/aura-memory-ttl` (`aura/memory-batch`) |
| 이벤트 | `aura.events.memory.ttl.done` / `.error` |
| 매니페스트 | [`deploy/k8s/memory-ttl/`](../../deploy/k8s/memory-ttl/) · **deployment 없음** |

**정본:** [`deploy/docs/memory-ttl-drop.md`](../../deploy/docs/memory-ttl-drop.md) · 수치 [`memory-ttl-policy.md`](../../deploy/docs/memory-ttl-policy.md)

| kind | 핫 | 액션 |
|------|----|------|
| `short_term` | 14일 | 만료 월 파티션 **DROP RESTRICT** |
| `audit` | 12개월 | 만료 월 파티션 **DROP RESTRICT** |
| `episodic` | 24개월 | 콜드 → **`needs_archive`** (archive 완료·`archived=true` 후에만 DROP) |

금지: Soft-delete-only · `DROP … CASCADE` · 미허용 테이블명. DDL은 공유 스키마(테넌트 RLS 밖). Pooler host만.

---

## Consolidate CronJob (§3.2 · §5 · M4)

| 필드 | 값 |
|------|-----|
| task id | `aura.tasks.memory.consolidate` (식별용 · JetStream durable **아님**) |
| 실행 | **CronJob** `aura-memory-consolidate-cron` → `/aura-memory-consolidate` (`aura/memory-batch`) |
| 이벤트 | `aura.events.memory.consolidated` / `.error` |
| 매니페스트 | [`deploy/k8s/memory-consolidate/`](../../deploy/k8s/memory-consolidate/) · **deployment 없음** |

**승격 규칙 (정본):** [`deploy/docs/memory-consolidate-promotion.md`](../../deploy/docs/memory-consolidate-promotion.md)

| 항목 | 규칙 |
|------|------|
| 허용 전이 | `short_term`→`episodic` · `episodic`→`long_term` · `episodic`→`semantic` |
| 사유 | `session_boundary` / `recurrence`(evidence_count **≥ 3**) / `llm_extract` / `operator` |
| 금지 | `similarity_only` · reason 누락 · 건너뛰기·역방향 · in-place `UPDATE memory_type` |
| 물리 | `soft_close`(`valid_until`) + `insert_promoted`(`supersedes_id`) — LIST 파티션 |
| GUC | `withTenantTx` → `set_config('app.tenant_id', $1, true)` |

입력: §8 + `payload.from_type` · `to_type` · `reason` · `item_id` · `created_at` · (선택) `evidence_count`/`similarity`.  
성공 본문 `type: memory.consolidated`. store/embed/recall은 유형을 **승격하지 않는다**.

---

## Recall RPC (§3.3 · §4.2 · M2)

| 필드 | 값 |
|------|-----|
| subject | `aura.rpc.memory.recall` |
| NATS | 공용 `aura-nats-rpc-bridge` · queue `aura-rpc-bridge` · **replicas ≥ 2** |
| Target | Deployment+Service `aura-memory-recall` · **lab replicas=1**(목표≥2) · ns `aura` |
| 트리거 | 브리지 → Service HTTP — **MQT 없음** · **JetStream lag ScaledObject 없음** · **서비스별 `*-rr` 없음** · **Fission Function 아님** |
| 매니페스트 | [`deploy/k8s/memory-recall/`](../../deploy/k8s/memory-recall/) · 브리지 [`deploy/k8s/nats-rpc-bridge/`](../../deploy/k8s/nats-rpc-bridge/) |

요청 envelope: ARCHITECTURE §6.3 (`tenant_id` · `query` · 선택 `types`/`top_k`/`session_id`/`principal_id` · 선택 `query_embedding[]`).  
핸들러(`aura-memory-recall` / `handlers.rs`): `mode: hybrid_rrf` · `type: memory.recall.done`.

| 단계 | 동작 |
|------|------|
| GUC | `withTenantTx` → `set_config('app.tenant_id', $1, true)` → `SET LOCAL hnsw.iterative_scan=relaxed_order` · `ef_search=40` · `max_scan_tuples=20000` |
| `short_term` | HNSW 없이 `ORDER BY created_at DESC` · 선택 `session_id` · **tenant WHERE 동일 SQL** · 슬롯 예산 기본 4 |
| BM25 | `content_tsv @@ plainto_tsquery` · `memory_type IN (episodic,long_term,semantic)` · tenant WHERE |
| vector | `query_embedding` 있을 때만 · 활성 `model_key` · `(embedding::halfvec(N)) <=> q` · tenant WHERE **동일 SQL**(앱 post-filter 금지) |
| graph | **walk** `graph-walk.js` — BM25/vector 시드 → 방어적 1–2홉(visited · per_hop_limit · supernode_degree_cap · 유효 predicate · out+in) · RRF 분기 weight 0.5 ([`memory-graph-traversal.md`](../../deploy/docs/memory-graph-traversal.md)) |
| fuse | RRF `k=60` · BM25+vector(+graph weight 0.5) → short_term 블록 앞 + hybrid 나머지 = `top_k` |

`AURA_DATABASE_HOST`는 `aura-pg-pooler`만(RO pooler OK). Agent는 이 RPC만 사용한다(§1 #9).

**Agent 주입 (M2 계약 · 패킹=M3):** recall `items[]`만 프롬프트 슬롯에 넣는다 — short_term / episodic / long_term+semantic 분리, 합계 **2048** 토큰(short **512** / epi **768** / lt+sem **768**), short 아이템 **4** · `top_k` **12**. 원문 전량·`content_ref` 우회 덤프 금지. 수치·금지: [`deploy/docs/agent-inject-contract.md`](../../deploy/docs/agent-inject-contract.md) · 게이트 `check-agent-inject-contract.sh`. `agent_invoke` 패킹 본구현은 M3.

---

## 트랜잭션 헬퍼

`aura-tenant-tx` / memory lib — `set_config('app.tenant_id', $1, true)` (sqlx 후속).  
store·embed·consolidate·**recall** handler는 이 헬퍼만 경유한다(short_term embed skip 제외).

---

## Commands

```bash
cargo test -p aura-memory
bash deploy/scripts/check-memory-capture.sh
bash deploy/scripts/check-memory-recall.sh
bash deploy/scripts/check-memory-ttl.sh
bash deploy/scripts/check-memory-consolidate.sh
bash deploy/scripts/check-memory-archive.sh
bash deploy/scripts/check-object-store-orphan-gc.sh
bash deploy/scripts/check-memory-control-hardcode.sh
bash deploy/scripts/build-hardcoded-memory-images.sh
docker build -f services/memory/Dockerfile.capture -t aura/memory-capture:local .
docker build -f services/memory/Dockerfile.recall -t aura/memory-recall:local .
docker build -f services/memory/Dockerfile.batch -t aura/memory-batch:local .
```

---

## 관련 링크

- §2.1 Pooler · §3.2 store/embed/consolidate/ttl/object_gc · §3.3 recall subject · §5 승격 [`deploy/docs/memory-consolidate-promotion.md`](../../deploy/docs/memory-consolidate-promotion.md) · §6.2.2 TTL [`deploy/docs/memory-ttl-drop.md`](../../deploy/docs/memory-ttl-drop.md) · §6.2.4 graph [`deploy/docs/memory-graph-traversal.md`](../../deploy/docs/memory-graph-traversal.md) · 슈퍼노드 [`deploy/docs/memory-graph-supernode-fixture.md`](../../deploy/docs/memory-graph-supernode-fixture.md) · §6.3 hybrid · §8 `content_ref` [`deploy/docs/object-store-content-ref.md`](../../deploy/docs/object-store-content-ref.md) · 고아 GC [`deploy/docs/object-store-orphan-gc.md`](../../deploy/docs/object-store-orphan-gc.md) · Agent 주입 [`deploy/docs/agent-inject-contract.md`](../../deploy/docs/agent-inject-contract.md) · Pooler 스모크 [`deploy/docs/pg-pooler-smoke-plan.md`](../../deploy/docs/pg-pooler-smoke-plan.md)
- ROADMAP M1 store · M2 embed · M2 recall RPC Warm · M2 «recall hybrid RRF» · M2 «Agent 주입 계약» · M2 «Object Store V2.1» · M2 «고아 GC V2.2» · M4 consolidate · M4 graph walk · M4 슈퍼노드 · M4 ttl · M4 archive · M4 object_gc
