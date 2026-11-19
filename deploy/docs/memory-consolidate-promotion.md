# memory_type 승격 규칙 (M4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #7 · **§5** · §3.2 `aura.tasks.memory.consolidate`.  
일정: [ROADMAP.md](../../ROADMAP.md) M4.  
코드: [`services/memory/consolidate/`](../../services/memory/consolidate/) (`promote.js` · `handler.js`).

**이 문서 범위:** 허용 전이·사유·물리 연산(soft_close+INSERT)·유사도 단독 금지 수치/규칙을 **고정**.  
**Non-goals:** LLM extract 본문 · graph node/edge 쓰기 · TTL/archive · 실 `memory_items` UPSERT 본문(동일 헬퍼 위 후속).

수치·전이 출처: ARCHITECTURE §5. 운영 튜닝은 결정 로그 1행 + 이 문서·§5를 **같이** 고친다.

---

## 불변식 (성공 기준)

- **`aura.tasks.memory.consolidate`만** `memory_type`을 바꾼다 (승격·병합·soft 삭제).
- **유사도 점수만으로** `memory_type`을 바꾸지 않는다 (`reason=similarity_only` · reason 누락+score → 거부).
- store / embed / recall / capture는 유형을 **생성·인덱싱·조회**만 하고 **승격하지 않는다**.

---

## 허용 전이 (M4 고정)

| from | to | 비고 |
|------|-----|------|
| `short_term` | `episodic` | 세션 경계 등 |
| `episodic` | `long_term` | 오래 참인 사실·선호 |
| `episodic` | `semantic` | 개념·관계 (graph 합류는 후속) |

**금지:** `short_term`→`long_term`/`semantic`(건너뛰기) · 역방향 · `long_term`↔`semantic` · 동일 유형 «승격» · in-place `UPDATE memory_type`.

---

## 사유 (reason)

| reason | 의미 | 추가 조건 |
|--------|------|-----------|
| `session_boundary` | 세션/턴 경계 정리 | — |
| `recurrence` | 반복 증거 승격 | `evidence_count` **≥ 3** (M4 고정) |
| `llm_extract` | consolidate LLM 추출 결과 | — |
| `operator` | 운영/수동 | — |

**금지 reason:** `similarity_only`. 유사도는 후보 순위용 **보조 신호**일 수 있으나 단독 트리거 불가.

---

## 물리 연산 (LIST 파티션)

`memory_items`는 `PARTITION BY LIST (memory_type)` 이므로 **행의 `memory_type`을 UPDATE하지 않는다**.

| 단계 | op | 의미 |
|------|-----|------|
| 1 | `soft_close` | 원본 `(id, from_type, created_at)`에 `valid_until=now()` |
| 2 | `insert_promoted` | 새 행 `to_type` INSERT · `supersedes_id` = 원본 `id` |

쓰기 소유: `svc-memory` consolidate만 (§1 #5).

---

## 담당 태스크

| Subject | Consumer | resp / error |
|---------|----------|--------------|
| `aura.tasks.memory.consolidate` | `aura_memory_consolidate` | `aura.events.memory.consolidated` / `aura.events.memory.consolidate.error` |

MQT · `minReplicaCount=0` · stream `AURA_TASKS` (§3.2 · §4.1).

---

## 관련 링크

- §5 승격 요약 · §3.2 task 표 · §6.1 쓰기 소유
- 정적 게이트: `bash deploy/scripts/check-memory-consolidate.sh`
- selftest: `node services/memory/consolidate/promote.selftest.js` · `handler.selftest.js`
