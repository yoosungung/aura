# 활성 AURA_EMBEDDING_* 핀 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3 · **§6.2.1**.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (활성 모델 실값) · 세대 교체 절차는 [`memory-embeddings-generation.md`](memory-embeddings-generation.md).  
TTL 수치(14일/24개월/12개월)는 이 문서 범위 밖 — [`memory-ttl-policy.md`](memory-ttl-policy.md) (이미 M1 고정).

**이 문서 범위:** 생산 embed/recall이 읽는 **활성** `AURA_EMBEDDING_MODEL` / `version` / `dims` 와 파생 `model_key`를 수치와 함께 고정.  
**Non-goals:** TEI/Deploy 매니페스트 · HF revision digest 핀 · `svc-memory` store/embed Function 본문 · fixture `fixture:v*` · T1/T2 스키마 · 스모크 재실행.

수치 출처: 공유 클러스터 TEI 워크로드 이름 `bge-m3-tei`(ops 기준선) + Hugging Face `BAAI/bge-m3` dense **1024** dims. 여기서 새 모델/차원을 발명하지 않는다. 교체 시 결정 로그 1행 + 이 문서·§6.2.1을 **같이** 고친다.

---

## 고정 실값 (M1)

| Env | 값 | 비고 |
|-----|-----|------|
| `AURA_EMBEDDING_MODEL` | `BAAI/bge-m3` | HF model id · dense 경로만 (sparse/ColBERT 비채택) |
| `AURA_EMBEDDING_VERSION` | `1` | **운영 세대** 문자열(첫 생산 파티션). HF git revision digest 아님 |
| `AURA_EMBEDDING_DIMS` | `1024` | BGE-M3 dense 출력 차원(model card) |
| (파생) `model_key` | `BAAI/bge-m3:1` | `model \|\| ':' \|\| version` (§6.2.1) |

Serving 힌트(참고, SoR 아님): 클러스터 Deploy/Service 이름 `bge-m3-tei`(TEI). Aura 로컬 ns에는 TEI가 없을 수 있다 — 핀은 **모델·차원·세대**이지 엔드포인트 URL이 아니다.

파티션 리프(생산, 스모크 fixture와 구분):

```sql
-- 예시 — 적용 스크립트는 ops/후속; fixture:v* 와 혼용 금지
CREATE TABLE memory_embeddings_p_bge_m3_1
  PARTITION OF memory_embeddings FOR VALUES IN ('BAAI/bge-m3:1');
ALTER TABLE memory_embeddings_p_bge_m3_1
  ADD CONSTRAINT memory_embeddings_p_bge_m3_1_dims CHECK (dims = 1024);
CREATE INDEX ON memory_embeddings_p_bge_m3_1
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops);
```

**금지:** fixture dims=3을 생산으로 승격 · 활성 `model_key`와 다른 파티션을 recall에 혼비교 · `short_term` embed.

---

## V1.x 매핑

ROADMAP M1 «활성 `AURA_EMBEDDING_*` → 결정 로그» → **이 문서** + `check-memory-embedding-active.sh`.  
세대 ATTACH/전환/DETACH 절차 본문은 [`memory-embeddings-generation.md`](memory-embeddings-generation.md).

---

## 관련 링크

- §6.2.1 · ROADMAP 결정 로그 (2026-11-18 활성 임베딩 M1 고정)
- TTL: [`memory-ttl-policy.md`](memory-ttl-policy.md)
- 정적 게이트: `bash deploy/scripts/check-memory-embedding-active.sh`
