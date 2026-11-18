# 멀티테넌트 HNSW 왜곡 픽스처 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #14 · **§6.2.3**.  
수치 전제: [`memory-embed-guard-iterative-scan.md`](memory-embed-guard-iterative-scan.md) (`relaxed_order` · `ef_search=40` · `max_scan_tuples=20000`).  
DDL 전제(pgvector≥0.8): [`../sql/memory_embeddings.sql`](../sql/memory_embeddings.sql).

**이 문서 범위:** 공유 HNSW에서 **대형 A + 소형 B** 왜곡으로  
(1) `hnsw.iterative_scan=relaxed_order` → 테넌트 B recall **≥1**,  
(2) `iterative_scan=off` → B **0건**(함정 재현) 대조 회귀를 고정한다.  
실패·SLO 미달 시 **T1/T2** 승격 경로를 명시한다.

**Non-goals:** 생산 `AURA_EMBEDDING_*` 실값 · `svc-memory` store/recall 본구현 · T1/T2 스키마 즉시 적용 · 앱 post-filter 허용 · 생산 cosine 인덱스를 L2로 교체.

---

## 픽스처 형태

스모크는 **픽스처 전용 테이블**을 쓴다(부모 `memory_embeddings` PK/UNIQUE가 ANN 대신 exact filter+sort를 고르는 것을 피함). 생산 DDL·RLS·cosine 인덱스는 그대로 둔다.

| 항목 | 값 |
|------|-----|
| 테이블 | `hnsw_mt_fixture` (스모크 ephemeral) |
| `dims` | **3** |
| 거리 | **`halfvec_l2_ops`** + `<=>` 가 아닌 `<->` (L2) |
| 테넌트 A | **2000** rows — 질의 `[0,0,0]` 근처 소량 노이즈 |
| 테넌트 B | **2** rows — `[0.2,0,0]` / `[0.21,0,0]` (근방이나 첫 ef_search 창 밖) |
| `LIMIT` | **10** |
| HNSW 강제 | `enable_seqscan=off` |
| ON | `hnsw.iterative_scan=relaxed_order` (+ ef_search/max_scan_tuples M1 수치) → B **≥1** |
| OFF | `hnsw.iterative_scan=off` → B **0** |

**금지:** 전역 Top-K 후 앱에서 `tenant_id`만 걸러 쓰기 · OFF를 운영 기본으로 두기.

스모크: `smoke-memory-hnsw-multitenant.sh` (live via Pooler 또는 `SMOKE_MEMORY_HNSW_MT_STATIC=1`).

### 왜 L2 픽스처인가 (cosine 갭)

생산 파티션 인덱스는 **`halfvec_cosine_ops`**(방안 B). 동일 왜곡을 cosine으로 재현하면 pgvector 0.8.7에서 **OFF=0이면서 ON도 0**(iterative_scan이 B를 회수하지 못함)이 관측되었다.  
M1은 **iterative_scan GUC 메커니즘**을 L2 픽스처로 회귀 고정하고, cosine 왜곡 회수는 **결정 로그에 갭**으로 남긴다 — 운영 전 cosine 재실측 또는 T1/T2 후보.

---

## 합격 / 실패

| 결과 | 의미 | 다음 |
|------|------|------|
| ON≥1 ∧ OFF=0 (L2 픽스처) | iterative_scan 메커니즘 입증 | M1 체크 완료; 기본 배포 = 공유 `model_key` + iterative_scan |
| ON 미달 (&lt;1) | 픽스처·환경에서 iterative_scan만으로 부족 | **스모크 FAIL** → T1/T2 승격 후보를 결정 로그에 기록 |
| OFF≥1 | 왜곡이 약함(함정 미재현) | A 밀도/거리를 키워 OFF=0이 되도록 조정 |
| 생산 cosine 왜곡 ON 미달 | 메커니즘≠생산 ops | 결정 로그 갭 · cosine 재실측 또는 T1/T2 (스키마 미적용) |

---

## 승격 경로 (T1 / T2) — 실패·KPI 미달 시에만

ARCHITECTURE §6.2.3과 동일. **기본 배포에 T1/T2를 미리 넣지 않는다.**

| 옵션 | 내용 | 언제 |
|------|------|------|
| **T1** | `tenant_bucket = hash(tenant_id) % N` + LIST/HASH 서브파티션 + 버킷별 HNSW | ON 픽스처 실패 또는 운영 소형 테넌트 recall SLO 미달 · **cosine 왜곡 미회수** |
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
