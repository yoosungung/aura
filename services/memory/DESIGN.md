# svc-memory (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#5 · §2.1 · §3.2–§3.3 · §4.2 · §6.3.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (store MQT + `set_config`) · M2 (embed MQT · recall Warm · **hybrid RRF SELECT**).  
DDL: [`deploy/sql/`](../../deploy/sql/) · 활성 핀: [`deploy/docs/memory-embedding-active.md`](../../deploy/docs/memory-embedding-active.md) · 가드: [`deploy/docs/memory-embed-guard-iterative-scan.md`](../../deploy/docs/memory-embed-guard-iterative-scan.md).

**이 문서 범위:** `svc-memory` **store** + **embed**(async MQT) + **recall**(sync Core RR + hybrid SELECT).  
**Non-goals (본 슬라이스):** graph walk 본구현(M4 · stub만) · consolidate/ttl/archive · 라이브 TEI HTTP(query_embedding 없으면 vector 스킵) · 실 `halfvec` INSERT · capture Function(→ [`../memory-capture/DESIGN.md`](../memory-capture/DESIGN.md)) · live 클러스터 apply 필수(정적 게이트만).

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
| graph | **stub** `{ mode: stub, candidates: [] }` — M4 walk가 RRF 분기로 합류 |
| fuse | RRF `k=60` · BM25+vector(+graph stub weight 0.5) → short_term 블록 앞 + hybrid 나머지 = `top_k` |

`AURA_DATABASE_HOST`는 `aura-pg-pooler`만(RO pooler OK). Agent는 이 RPC만 사용한다(§1 #9).

---

## 트랜잭션 헬퍼

`services/memory/store/tenant-tx.js` — `BEGIN` → `set_config('app.tenant_id', $1, true)` → work → `COMMIT`/`ROLLBACK`.  
store·embed·**recall** handler는 이 헬퍼만 경유한다(short_term embed skip 제외).

---

## Commands

```bash
bash deploy/scripts/check-memory-store.sh          # DESIGN + store MQT + set_config(..., true) + selftests
bash deploy/scripts/check-memory-embed.sh          # DESIGN + embed MQT + short_term skip + selftests
bash deploy/scripts/check-memory-recall.sh         # DESIGN + hybrid RRF + GUCs + Warm Pool + no MQT + selftests
node services/memory/store/tenant-tx.selftest.js   # fake client: true before work, never false
node services/memory/store/handler.selftest.js     # MQT handler → withTenantTx
node services/memory/embed/handler.selftest.js     # short_term skip · embeddable withTenantTx
node services/memory/recall/handler.selftest.js    # hybrid RRF · GUC · tenant WHERE · graph stub
```

---

## 관련 링크

- §2.1 Pooler · §3.2 store/embed · §3.3 recall subject · §6.3 hybrid · Pooler 스모크 [`deploy/docs/pg-pooler-smoke-plan.md`](../../deploy/docs/pg-pooler-smoke-plan.md)
- ROADMAP M1 store · M2 embed · M2 recall RPC Warm · M2 «recall hybrid RRF»
