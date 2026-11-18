# short_term / episodic / audit 만료 정리 정책 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #8 · **§6.2.2**.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (수치 고정) · M4 (`aura.tasks.memory.ttl` / `archive` **구현**).  
전제 DDL: [`../sql/memory_items.sql`](../sql/memory_items.sql) · [`../sql/memory_audit.sql`](../sql/memory_audit.sql).

**이 문서 범위:** 핫 유지 일수·월 파티션 DROP 판정·담당 태스크 이름을 **수치와 함께 고정**.  
**Non-goals:** TTL/archive Function 본구현 · embeddings/HNSW · nodes/edges · `svc-memory` store 본문 · Soft-delete-only 대량 정리.

수치 출처: ARCHITECTURE §6.2.2 (기획 확정 초안). 운영 튜닝은 M4 부하 후 결정 로그 1행 + 이 문서·§6.2.2를 **같이** 고친다 — 여기서 새 숫자를 발명하지 않는다.

---

## 고정 수치 (M1)

| 대상 | 파티션 | 핫 유지 | 물리 제거 |
|------|--------|---------|-----------|
| `memory_items` / `short_term` | LIST(`short_term`) + **월 RANGE**(`created_at`) | **14일** | 월 파티션 **DROP** (`DELETE`+`VACUUM` 비선호). 내구 HNSW **미사용** |
| `memory_items` / `episodic` | LIST(`episodic`) + **월 RANGE** | **24개월** (핫) | 콜드: `aura.tasks.memory.archive` → Parquet → **DETACH/DROP** |
| `memory_audit` | **월 RANGE**(`created_at`) | **12개월** | 오래된 월 파티션 **DROP** |
| `long_term` / `semantic` | LIST 리프 | 장기 | 이 정책의 DROP 대상 아님 (`valid_until` · consolidate) |

`valid_until`은 논리 만료·승격용이다. **디스크/인덱스 회수 정본 = 파티션 DROP·아카이브**.

---

## 월 파티션 DROP 판정

파티션 상한(exclusive upper bound)을 `U`, 기준 시각을 `now()`(UTC)라 할 때:

| 대상 | DROP 조건 (M1 고정) |
|------|---------------------|
| `short_term` 월 자식 | `U <= now() - interval '14 days'` |
| `episodic` 월 자식 | 핫 창 밖(`U <= now() - interval '24 months'`)이면 **먼저 archive**, 성공 후에만 DETACH/DROP (M4) |
| `memory_audit` 월 자식 | `U <= now() - interval '12 months'` |

- **시드/스모크:** prev/current/next 월 ATTACH는 핫 창 안이면 DROP하지 않는다.
- **경계:** short_term 14일은 월 경계와 어긋날 수 있다 — 판정은 위 interval만 쓴다(「이번 달 통째 유지」휴리스틱 금지).
- **금지:** Soft delete만으로 short_term/episodic/audit 핫 파티션을 무기한 방치.

---

## 담당 태스크

| Subject | Consumer / Function | 역할 (M4 구현) | 완료 이벤트 |
|---------|---------------------|----------------|-------------|
| `aura.tasks.memory.ttl` | `aura_memory_ttl` / `svc-memory` ttl | 만료 **short_term**·(정책상) **audit** 월 파티션 DROP; episodic는 archive 경로와 조율 | `aura.events.memory.ttl.done` / `.error` |
| `aura.tasks.memory.archive` | `aura_memory_archive` / `svc-memory` archive | 콜드 episodic Parquet export → object store → DETACH/DROP | `aura.events.memory.archived` / archive error |

MQT·scale-to-zero OK (ARCHITECTURE §3.2). M1은 **이름·수치·판정만** 고정하고 Function/스케줄 CR은 만들지 않는다.

---

## V1.3 매핑

ROADMAP M1 V1.3: *items/audit 파티션 + short_term 만료 정책* → 비파티션 힙 없음(DDL 티켓) + **이 문서 수치**.  
구현·스모크(실 DROP)는 M4 «`aura.tasks.memory.ttl` — 만료 short_term/episodic/audit 월 파티션 DROP».

---

## 관련 링크

- §6.2.2 · §3.2 task 표
- ROADMAP 결정 로그 (2026-11-18 TTL 수치 M1 고정)
- 정적 게이트: `bash deploy/scripts/check-memory-ttl.sh`
