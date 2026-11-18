# short_term embed 거부 + iterative_scan / ef_search (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #8·#14 · **§6.2.1** · **§6.2.3** · **§6.3**.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (가드·수치 고정) · M2 (`aura.tasks.memory.embed` skip · recall SET LOCAL **구현**).  
전제 DDL: [`../sql/memory_embeddings.sql`](../sql/memory_embeddings.sql).

**이 문서 범위:** (1) `short_term` → `memory_embeddings` **거부** 경로(DDL SoR + 앱 계약) 명시.  
(2) 공유 HNSW recall용 **pgvector ≥ 0.8** · `hnsw.iterative_scan` · `ef_search` · `max_scan_tuples` 수치 **고정**.  
**Non-goals:** 왜곡 테넌트 HNSW 픽스처(ON≥1/OFF 대조) → [`memory-hnsw-multitenant-fixture.md`](memory-hnsw-multitenant-fixture.md) · 생산 `AURA_EMBEDDING_*` 실값 · `svc-memory` store/embed/recall 본구현 · T1/T2 테넌트 파티션.

수치 출처: ARCHITECTURE §6.3 초안(`ef_search` 예: 40+) · §6.2.3 · pgvector 0.8 기본값. 운영 튜닝은 M2/M4 픽스처·부하 후 결정 로그 1행 + 이 문서·§6.2.3/§6.3을 **같이** 고친다 — 여기서 새 숫자를 발명하지 않는다.

---

## short_term embed 거부 (이중 가드)

| 경로 | M1 상태 | 계약 |
|------|---------|------|
| **DDL (SoR)** | **고정** | `memory_embeddings.memory_type CHECK (memory_type IN ('episodic','long_term','semantic'))` — `short_term` INSERT는 DB가 거부 |
| **앱 (계약)** | **M2 구현** | `aura.tasks.memory.embed` / embed Function은 `short_term` 후보를 **스킵·거부**하고 INSERT를 시도하지 않음 (`services/memory/embed/` · `check-memory-embed.sh`). CHECK만으로 제어 흐름을 대체하지 않음 |
| **recall** | 계약 | `short_term` = 세션 **최근순**(relational)만. HNSW/벡터 경로에 넣지 않음 (§6.3 #2) |

**금지:** Soft path로 `short_term` 행을 임베딩 테이블에 적재 · 앱이 CHECK 실패를 “정상 skip”으로만 삼고 사전 필터를 생략.

스모크(실측 또는 static): `short_term` INSERT 실패 · (동반) 부모 undimensioned `hnsw(embedding)` 생성 실패 — `smoke-memory-embed-guard.sh`.

---

## pgvector · iterative_scan · ef_search (M1 고정)

| 항목 | 값 | 의미 |
|------|-----|------|
| pgvector | **≥ 0.8** | `hnsw.iterative_scan` 지원 최소. 미만 배포 금지 |
| `hnsw.iterative_scan` | **`relaxed_order`** | 매 recall 트랜잭션 `SET LOCAL`. `off` 금지(공유 HNSW+테넌트 WHERE). `strict_order`는 M1 비기본(지연↑) |
| `hnsw.ef_search` | **40** | 매 recall `SET LOCAL`. pgvector 기본·§6.3 초안 하한 |
| `hnsw.max_scan_tuples` | **20000** | iterative 스캔 상한(대략). 기본값 유지; recall 미달 시 결정 로그 후 상향 |
| `hnsw.scan_mem_multiplier` | **1** (기본) | max_scan_tuples 올려도 부족할 때만 결정 로그 후 상향 |
| SQL | 한 쿼리 | `WHERE tenant_id = $1 AND … ORDER BY (embedding::halfvec(N)) <=> $q LIMIT $k` |
| 금지 | 앱 post-filter | 전역 Top-K 후 앱에서 `tenant_id`만 걸러 쓰지 않음 |

```sql
-- recall 트랜잭션 시작 시 (M2 구현 · 수치=이 문서)
SET LOCAL hnsw.iterative_scan = relaxed_order;
SET LOCAL hnsw.ef_search = 40;
SET LOCAL hnsw.max_scan_tuples = 20000;
```

`relaxed_order`로 거리 순서가 약간 흐트러일 수 있으면, 필요 시 materialized CTE로 재정렬(§6.3 / pgvector 문서). M1은 **모드·수치만** 고정한다.

왜곡 테넌트 픽스처(대형 A / 소형 B · ON≥1 / OFF 대조): [`memory-hnsw-multitenant-fixture.md`](memory-hnsw-multitenant-fixture.md).

---

## V1.x 매핑

ROADMAP M1: *short_term embed 거부 가드; pgvector ≥ 0.8; ef_search / iterative_scan DESIGN* → 이 문서 + DDL CHECK + `check-memory-embed-guard.sh` / `smoke-memory-embed-guard.sh`.  
멀티테넌트 픽스처: [`memory-hnsw-multitenant-fixture.md`](memory-hnsw-multitenant-fixture.md). 생산 dims·embed Function 본문은 후속 체크.

---

## 관련 링크

- §6.2.1 · §6.2.3 · §6.3 · §1 #8·#14
- 세대 교체: [`memory-embeddings-generation.md`](memory-embeddings-generation.md)
- ROADMAP 결정 로그 (2026-11-18 short_term 가드 + iterative_scan 수치 M1 고정)
- 정적 게이트: `bash deploy/scripts/check-memory-embed-guard.sh`
