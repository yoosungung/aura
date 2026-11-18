# memory_embeddings 모델 세대 교체 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3 · **§6.2.1**.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (DDL·절차 고정) · 활성 모델 실값 = [`memory-embedding-active.md`](memory-embedding-active.md).  
전제 DDL: [`../sql/memory_embeddings.sql`](../sql/memory_embeddings.sql).

**이 문서 범위:** LIST(`model_key`) + 파티션별 `halfvec(N)` HNSW 형태와 **ATTACH → 전환 → DETACH** 절차 고정.  
**Non-goals:** 활성 핀 재발명(→ active 문서) · HNSW 왜곡 픽스처 · `svc-memory` store 본문 · T1/T2 테넌트 파티션.  
short_term 거부·`iterative_scan`/`ef_search` 수치는 [`memory-embed-guard-iterative-scan.md`](memory-embed-guard-iterative-scan.md).

스모크는 **`fixture:v*`** model_key만 사용한다. fixture ≠ production `AURA_EMBEDDING_MODEL`/`version`/`dims`(생산=`BAAI/bge-m3:1` · dims=1024).

---

## 파티션·인덱스 형태 (§6.2.1)

| 규칙 | 내용 |
|------|------|
| 부모 | `embedding halfvec` (typemod 없음). **부모에 HNSW 금지** |
| 키 | `model_key = model \|\| ':' \|\| version` |
| 자식 | `FOR VALUES IN ('<model>:<version>')` + `CHECK (dims = <N>)` |
| 인덱스 | `USING hnsw ((embedding::halfvec(<N>)) halfvec_cosine_ops)` — **파티션마다** |
| 상한 | `dims ≤ 4000` (`halfvec` HNSW). `vector` HNSW 경로 비채택 |

`<N>`·`<model>`·`<version>` 생산 실값 SoR = [`memory-embedding-active.md`](memory-embedding-active.md) (`BAAI/bge-m3` / `1` / `1024`). 이 문서는 절차만.

---

## 세대 교체 절차 (M1 고정 · 구현 스크립트는 스모크/ops)

1. **ATTACH (새 세대)**  
   - `CREATE TABLE memory_embeddings_p_<slug> PARTITION OF memory_embeddings FOR VALUES IN ('<model>:<version>')`  
   - `ALTER TABLE … ADD CONSTRAINT … CHECK (dims = <N>)`  
   - `CREATE INDEX … ON memory_embeddings_p_<slug> USING hnsw ((embedding::halfvec(<N>)) halfvec_cosine_ops)`  
   - (선택) backfill / dual-write 배치 — `svc-memory` DESIGN (후속)

2. **전환 (active `model_key`)**  
   - embed 워커·recall 설정의 active `model_key`를 **새 키로만** 바꾼다.  
   - 혼비교 금지: recall은 활성 `model_key` 파티션만 질의 (§6.3).

3. **DETACH (구형)**  
   - 트래픽·백필 완료 확인 후 `ALTER TABLE memory_embeddings DETACH PARTITION memory_embeddings_p_<old_slug>`  
   - 보관 정책에 따라 `DROP TABLE memory_embeddings_p_<old_slug>` (테이블 rewrite 없이 제거).

**금지:** 부모 undimensioned HNSW · 단일 `vector(1536)` rewrite · 다모델 한 인덱스 · `short_term` embed 행.

---

## V1.2 매핑

ROADMAP M1 V1.2: *임베딩 세대 교체 DDL* → 이 문서 + [`../sql/memory_embeddings.sql`](../sql/memory_embeddings.sql) + `check-memory-embeddings.sh` / `smoke-memory-embeddings.sh` (fixture 실측 또는 static).

---

## 관련 링크

- §6.2.1 · §6 DDL · 결정 로그 (2026-11-17 방안 B · 2026-11-18 세대 교체 절차 · 활성 핀)
- 활성 핀: [`memory-embedding-active.md`](memory-embedding-active.md) · `check-memory-embedding-active.sh`
- 정적 게이트: `bash deploy/scripts/check-memory-embeddings.sh`
