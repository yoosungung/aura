# 멀티테넌트 HNSW 왜곡 픽스처 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #14 · **§6.2.3**.  
수치 전제: [`memory-embed-guard-iterative-scan.md`](memory-embed-guard-iterative-scan.md) (`relaxed_order` · `ef_search=40` · `max_scan_tuples=20000`).  
DDL: [`../sql/memory_embeddings.sql`](../sql/memory_embeddings.sql).

**이 문서 범위:** 공유 `model_key` HNSW에서 **대형 A + 소형 B** 왜곡 픽스처로  
(1) `hnsw.iterative_scan=relaxed_order` + `WHERE tenant_id=B` → B recall **≥1**,  
(2) **전역 Top-K 후 테넌트 필터**(iterative_scan=off / 앱 post-filter 함정) → B **0건** 대조 회귀,  
(3) 실패 시 **T1/T2** 승격 경로를 §6.2.3와 동일하게 고정.  
**Non-goals:** 생산 `AURA_EMBEDDING_*` 실값 · `svc-memory` store/recall 본구현 · T1/T2 스키마 즉시 적용 · 앱 post-filter 허용.

---

## 픽스처 형태

| 항목 | 값 |
|------|-----|
| `model_key` | `fixture:hnsw_mt` (≠ production) |
| `dims` | **3** (스모크 전용) |
| 테넌트 A | **500** rows — 질의 `q=[1,0,0]`와 **동일** 벡터(전역 Top-K 점유) |
| 테넌트 B | **2** rows — `q`보다 **약간 먼** 벡터 |
| `LIMIT` / Top-K | **10** |
| OFF (함정) | RLS 일시 해제 후 `ORDER BY <=> q LIMIT 10` **전역** → 그 결과에서 `tenant_id=B` 카운트 → **0** |
| ON (합격) | FORCE RLS + `iterative_scan=relaxed_order` + `WHERE tenant_id=B … LIMIT 10` → B **≥1** |
| HNSW 강제 | 스모크만 parent `UNIQUE(item_id,model_key)` DROP + `enable_seqscan/bitmapscan=off` (tiny N에서 btree 회피; **prod DDL은 UNIQUE 유지**) |

**금지:** 운영에서 전역 Top-K 후 앱/`WITH`로 `tenant_id`만 걸러 쓰기 · OFF를 운영 기본으로 두기.

스모크: `smoke-memory-hnsw-multitenant.sh` (live via Pooler 또는 `SMOKE_MEMORY_HNSW_MT_STATIC=1`).

---

## 합격 / 실패

| 결과 | 의미 | 다음 |
|------|------|------|
| ON≥1 ∧ OFF=0 | iterative_scan 계약 입증 | M1 체크 완료; 기본 배포 = 공유 `model_key` + iterative_scan |
| ON 미달 (&lt;1) | 픽스처·환경에서 iterative_scan만으로 부족 | **스모크 FAIL** → 아래 T1/T2 승격 후보를 결정 로그에 기록 후 스키마 티켓 |
| OFF≥1 | 왜곡이 약함(함정 미재현) | A 밀도·거리를 키워 OFF=0이 되도록 조정 |

---

## 승격 경로 (T1 / T2) — 실패·KPI 미달 시에만

ARCHITECTURE §6.2.3과 동일. **기본 배포에 T1/T2를 미리 넣지 않는다.**

| 옵션 | 내용 | 언제 |
|------|------|------|
| **T1** | `tenant_bucket = hash(tenant_id) % N` + LIST/HASH 서브파티션 + 버킷별 HNSW | ON 픽스처 실패 또는 운영에서 소형 테넌트 recall SLO 미달 |
| **T2** | whale 테넌트 전용 파티션/인덱스 | 단일 테넌트가 공유 HNSW를 지배할 때 |
| **T3** | 행 수 임계 미만 exact/BRIN+필터 또는 BM25 비중↑ | T1/T2 전 경량 대안(임계는 별도 DESIGN) |

승격 시: ROADMAP 결정 로그 1행 + 이 문서·§6.2.3을 **같이** 갱신. 실값·N·임계를 여기서 발명하지 않는다.

---

## V1.x 매핑

ROADMAP M1: *멀티테넌트 HNSW 픽스처: 대형 A + 소형 B — ON≥1 / OFF 대조; 실패 시 T1/T2*  
→ 이 문서 + `check-memory-hnsw-multitenant.sh` / `smoke-memory-hnsw-multitenant.sh`.

---

## 관련 링크

- §6.2.3 · §1 #14
- GUC 수치: [`memory-embed-guard-iterative-scan.md`](memory-embed-guard-iterative-scan.md)
- 세대 교체: [`memory-embeddings-generation.md`](memory-embeddings-generation.md)
- 정적 게이트: `bash deploy/scripts/check-memory-hnsw-multitenant.sh`
