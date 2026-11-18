# svc-memory (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#5 · §2.1 · §3.2–§3.3 · §4.2 · §6.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (store MQT + `set_config`) · M2 (embed MQT · **recall RPC Warm**).  
DDL: [`deploy/sql/`](../../deploy/sql/) · 활성 핀: [`deploy/docs/memory-embedding-active.md`](../../deploy/docs/memory-embedding-active.md) · 가드: [`deploy/docs/memory-embed-guard-iterative-scan.md`](../../deploy/docs/memory-embed-guard-iterative-scan.md).

**이 문서 범위:** `svc-memory` **store** + **embed**(async MQT) + **recall**(sync Core RR) 배포 경계.  
**Non-goals (본 슬라이스):** hybrid RRF / short_term 최근순 SQL · graph walk · consolidate/ttl/archive 본구현 · 라이브 TEI HTTP · 실 `halfvec` INSERT · capture Function(→ [`../memory-capture/DESIGN.md`](../memory-capture/DESIGN.md)) · live 클러스터 apply 필수(정적 게이트만).

수치·모델 발명 금지 — 생산 임베딩은 이미 `BAAI/bge-m3:1` 핀. store는 `memory_items` 적재만; embed는 `memory_embeddings`(HNSW) 의도 + BM25 적격 표시(`content_tsv`는 store GENERATED). recall 본구현(SELECT)은 sibling.

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

요청 envelope: ARCHITECTURE §6.3 (`tenant_id` · `query` · 선택 `types`/`top_k`/`session_id`/`principal_id`).  
본 슬라이스 핸들러(`services/memory/recall/handler.js`): 검증 후 `type: memory.recall.done` · `mode: stub` · `items: []` · **PG 미접속**.  
Sibling(hybrid RRF): short_term=최근순 · 나머지 RRF(+ graph stub) · `SET LOCAL hnsw.iterative_scan` / `ef_search=40` + tenant WHERE · Pooler + `set_config('app.tenant_id', $1, true)`.

Agent는 이 RPC만 사용한다(§1 #9). App post-filter 금지(§6.2.3).

---

## 트랜잭션 헬퍼

`services/memory/store/tenant-tx.js` — `BEGIN` → `set_config('app.tenant_id', $1, true)` → work → `COMMIT`/`ROLLBACK`.  
store·embed handler는 이 헬퍼만 경유한다(short_term skip 제외). recall stub은 헬퍼 미사용(sibling SELECT에서 재사용).

---

## Commands

```bash
bash deploy/scripts/check-memory-store.sh          # DESIGN + store MQT + set_config(..., true) + selftests
bash deploy/scripts/check-memory-embed.sh          # DESIGN + embed MQT + short_term skip + selftests
bash deploy/scripts/check-memory-recall.sh         # DESIGN + recall Warm Pool + Core QG + no MQT + selftests
node services/memory/store/tenant-tx.selftest.js   # fake client: true before work, never false
node services/memory/store/handler.selftest.js     # MQT handler → withTenantTx
node services/memory/embed/handler.selftest.js     # short_term skip · embeddable withTenantTx
node services/memory/recall/handler.selftest.js    # Core RR stub · no PG
```

---

## 관련 링크

- §2.1 Pooler · §3.2 store/embed · §3.3 recall subject · Pooler 스모크 [`deploy/docs/pg-pooler-smoke-plan.md`](../../deploy/docs/pg-pooler-smoke-plan.md)
- ROADMAP M1 store · M2 «embed Function (MQT) — short_term 스킵» · M2 «recall RPC Function 별도 배포»
