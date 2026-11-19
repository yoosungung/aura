# svc-memory (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#5 · §2.1 · §3.2–§3.3 · §4.2 · §5 · §6.3.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (store MQT + `set_config`) · M2 (embed MQT · recall Warm · **hybrid RRF SELECT**) · M4 (consolidate 유형 승격 · **recall graph 방어적 walk** · **ttl 월 파티션 DROP**).  
DDL: [`deploy/sql/`](../../deploy/sql/) · 활성 핀: [`deploy/docs/memory-embedding-active.md`](../../deploy/docs/memory-embedding-active.md) · 가드: [`deploy/docs/memory-embed-guard-iterative-scan.md`](../../deploy/docs/memory-embed-guard-iterative-scan.md) · 승격: [`deploy/docs/memory-consolidate-promotion.md`](../../deploy/docs/memory-consolidate-promotion.md) · 그래프: [`deploy/docs/memory-graph-traversal.md`](../../deploy/docs/memory-graph-traversal.md) · TTL: [`deploy/docs/memory-ttl-drop.md`](../../deploy/docs/memory-ttl-drop.md).

**이 문서 범위:** `svc-memory` **store** + **embed**(async MQT) + **recall**(sync Core RR + hybrid SELECT + **graph walk**) + **consolidate**(async MQT · 유형 승격 규칙) + **ttl**(async MQT · 월 파티션 DROP).  
**Non-goals (본 슬라이스):** archive Parquet 본문 · LLM extract 본문 · 라이브 TEI HTTP(query_embedding 없으면 vector 스킵) · 실 `halfvec`/`memory_items` UPSERT 본문 · capture Function(→ [`../memory-capture/DESIGN.md`](../memory-capture/DESIGN.md)) · live 클러스터 apply 필수(정적 게이트만) · `WITH RECURSIVE` · 슈퍼노드 픽스처는 [`memory-graph-supernode-fixture.md`](../../deploy/docs/memory-graph-supernode-fixture.md).

수치·모델 발명 금지 — 생산 임베딩은 이미 `BAAI/bge-m3:1` 핀. store는 `memory_items` 적재만; embed는 `memory_embeddings`(HNSW) 의도 + BM25 적격 표시(`content_tsv`는 store GENERATED).

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-memory`만 `memory_*` INSERT/UPDATE/DELETE (§1 #5) — **async store/embed만** |
| 실행 계급 (쓰기) | **async** MQT · `minReplicaCount=0` |
| 실행 계급 (recall) | **sync** Core RR · `minReplicas >= 2` · **MQT 없음** |
| PG | **CloudNativePG Pooler**만 — host `aura-pg-pooler…` (`AURA_DATABASE_HOST`). primary/Pod IP 금지. recall 읽기는 **RO Pooler** 가능(§9.6) |
| 테넌트 GUC | 매 트랜잭션 시작: `SELECT set_config('app.tenant_id', $1, true)` (SELECT 경로 포함) |
| 금지 | `set_config(..., false)` · 세션 `SET app.tenant_id` · 트랜잭션 밖 테넌트 상태 의존 · **`short_term` embed INSERT** · **recall에 MessageQueueTrigger / JetStream lag ScaledObject** |

---

## Store MQT (§3.2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.store` |
| consumer | `aura_memory_store` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.stored` |
| errorTopic | `aura.events.memory.store.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/memory-store/`](../../deploy/k8s/memory-store/) |

입력 envelope: §8 (`id` 멱등 키 · `tenant_id` · `payload` / `content_ref`).  
`content_ref` / 256KB / Object Store(**Garage**) 계약: [`deploy/docs/object-store-content-ref.md`](../../deploy/docs/object-store-content-ref.md) — 본 슬라이스는 업로드 본구현 없음(스키마만 준수).  
고아 `content_ref` GC(V2.2): [`deploy/docs/object-store-orphan-gc.md`](../../deploy/docs/object-store-orphan-gc.md) — `aura.tasks.memory.object_gc` · 90일 grace · live 참조 시 스킵 · 구현=M4.  
스켈레톤: `tenant_id` 검증 → `withTenantTx` → (stub) idempotent upsert 자리 · 성공 시 `type: memory.stored` 본문. 실 DDL INSERT·멱등 UNIQUE는 동일 헬퍼 위에서 확장(체크는 GUC 경로만 고정).

---

## Embed MQT (§3.2 · M2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.embed` |
| consumer | `aura_memory_embed` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.embedded` |
| errorTopic | `aura.events.memory.embed.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/memory-embed/`](../../deploy/k8s/memory-embed/) |

| `memory_type` | 동작 |
|---------------|------|
| `short_term` | **스킵** — HTTP 2xx `payload.status=skipped_short_term`; PG/`set_config`/INSERT **미시도** (DDL CHECK + 앱 이중 가드) |
| `episodic` / `long_term` / `semantic` | `withTenantTx` → 활성 `model_key` stub · HNSW 경로; BM25는 store `content_tsv` GIN 적격 (`indexes.hnsw/bm25=true`) |
| 기타 | 400 `memory_type_not_embeddable` |

활성 핀(기본=env 또는 M1 고정): `AURA_EMBEDDING_MODEL` / `VERSION` / `DIMS` → `model_key=model:version`.  
입력: §8 + `payload.memory_type` · `payload.item_id` · (선택) `content`. 성공 본문 `type: memory.embedded`.

---

## TTL MQT (§3.2 · §6.2.2 · M4)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.ttl` |
| consumer | `aura_memory_ttl` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.ttl.done` |
| errorTopic | `aura.events.memory.ttl.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/memory-ttl/`](../../deploy/k8s/memory-ttl/) |

**정본:** [`deploy/docs/memory-ttl-drop.md`](../../deploy/docs/memory-ttl-drop.md) · 수치 [`memory-ttl-policy.md`](../../deploy/docs/memory-ttl-policy.md)

| kind | 핫 | 액션 |
|------|----|------|
| `short_term` | 14일 | 만료 월 파티션 **DROP RESTRICT** |
| `audit` | 12개월 | 만료 월 파티션 **DROP RESTRICT** |
| `episodic` | 24개월 | 콜드 → **`needs_archive`** (archive 완료·`archived=true` 후에만 DROP) |

금지: Soft-delete-only · `DROP … CASCADE` · 미허용 테이블명. DDL은 공유 스키마(테넌트 RLS 밖). Pooler host만.

---

## Consolidate MQT (§3.2 · §5 · M4)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.consolidate` |
| consumer | `aura_memory_consolidate` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.consolidated` |
| errorTopic | `aura.events.memory.consolidate.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/memory-consolidate/`](../../deploy/k8s/memory-consolidate/) |

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
| queue-group | `aura-memory-recall` |
| 응답자 | Deployment `aura-memory-recall-rr` · **replicas ≥ 2** |
| Warm Function | `aura-memory-recall` · `newdeploy` · **MinScale ≥ 2** |
| 트리거 | 기동 시 NATS Core `nats reply -q` — **MQT 없음** · **JetStream lag ScaledObject 없음** |
| 매니페스트 | [`deploy/k8s/memory-recall/`](../../deploy/k8s/memory-recall/) |

요청 envelope: ARCHITECTURE §6.3 (`tenant_id` · `query` · 선택 `types`/`top_k`/`session_id`/`principal_id` · 선택 `query_embedding[]`).  
핸들러(`services/memory/recall/handler.js`): `mode: hybrid_rrf` · `type: memory.recall.done`.

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

`services/memory/store/tenant-tx.js` — `BEGIN` → `set_config('app.tenant_id', $1, true)` → work → `COMMIT`/`ROLLBACK`.  
store·embed·consolidate·**recall** handler는 이 헬퍼만 경유한다(short_term embed skip 제외).

---

## Commands

```bash
bash deploy/scripts/check-memory-store.sh          # DESIGN + store MQT + set_config(..., true) + selftests
bash deploy/scripts/check-memory-embed.sh          # DESIGN + embed MQT + short_term skip + selftests
bash deploy/scripts/check-memory-consolidate.sh    # 승격 규칙 + similarity_only 금지 + MQT + selftests
bash deploy/scripts/check-memory-ttl.sh            # TTL DROP 14d/24mo/12mo + needs_archive + MQT + selftests
bash deploy/scripts/check-memory-recall.sh         # DESIGN + hybrid RRF + graph walk + GUCs + Warm Pool + no MQT
bash deploy/scripts/check-memory-graph-traversal.sh # edges out/in + 순회 한도 + walk 구현
bash deploy/scripts/check-memory-graph-supernode.sh # hub≫cap · LIMIT/반환 상한 · 폭증 없음
bash deploy/scripts/check-agent-inject-contract.sh # Agent 주입 슬롯·토큰 예산 문서 게이트
bash deploy/scripts/check-object-store-content-ref.sh # Object Store=Garage · content_ref · 256KB
bash deploy/scripts/check-object-store-orphan-gc.sh   # 고아 GC 90d · object_gc · skip-if-ref
node services/memory/store/tenant-tx.selftest.js   # fake client: true before work, never false
node services/memory/store/handler.selftest.js     # MQT handler → withTenantTx
node services/memory/embed/handler.selftest.js     # short_term skip · embeddable withTenantTx
node services/memory/consolidate/promote.selftest.js  # 허용 전이 · similarity_only 거부
node services/memory/consolidate/handler.selftest.js  # consolidate MQT · withTenantTx · no UPDATE type
node services/memory/ttl/partition-plan.selftest.js   # 14d/24mo/12mo · needs_archive
node services/memory/ttl/handler.selftest.js          # DROP RESTRICT · episodic skip · unsafe name
node services/memory/recall/graph-walk.selftest.js # visited · depth≤2 · caps · 유효 predicate
node services/memory/recall/supernode-fixture.selftest.js # hub_degree=500 · candidates≤50 · LIMIT≤cap
node services/memory/recall/handler.selftest.js    # hybrid RRF · GUC · tenant WHERE · graph walk
```

---

## 관련 링크

- §2.1 Pooler · §3.2 store/embed/consolidate/ttl/object_gc · §3.3 recall subject · §5 승격 [`deploy/docs/memory-consolidate-promotion.md`](../../deploy/docs/memory-consolidate-promotion.md) · §6.2.2 TTL [`deploy/docs/memory-ttl-drop.md`](../../deploy/docs/memory-ttl-drop.md) · §6.2.4 graph [`deploy/docs/memory-graph-traversal.md`](../../deploy/docs/memory-graph-traversal.md) · 슈퍼노드 [`deploy/docs/memory-graph-supernode-fixture.md`](../../deploy/docs/memory-graph-supernode-fixture.md) · §6.3 hybrid · §8 `content_ref` [`deploy/docs/object-store-content-ref.md`](../../deploy/docs/object-store-content-ref.md) · 고아 GC [`deploy/docs/object-store-orphan-gc.md`](../../deploy/docs/object-store-orphan-gc.md) · Agent 주입 [`deploy/docs/agent-inject-contract.md`](../../deploy/docs/agent-inject-contract.md) · Pooler 스모크 [`deploy/docs/pg-pooler-smoke-plan.md`](../../deploy/docs/pg-pooler-smoke-plan.md)
- ROADMAP M1 store · M2 embed · M2 recall RPC Warm · M2 «recall hybrid RRF» · M2 «Agent 주입 계약» · M2 «Object Store V2.1» · M2 «고아 GC V2.2» · M4 consolidate 유형 승격 · M4 recall graph walk · M4 슈퍼노드 픽스처 · M4 ttl 월 파티션 DROP
