# `aura.tasks.memory.ttl` — 월 파티션 DROP (M4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #8 · §3.2 · **§6.2.2**.  
수치 정본: [`memory-ttl-policy.md`](memory-ttl-policy.md) (M1).  
일정: [ROADMAP.md](../../ROADMAP.md) M4.  
코드: [`services/memory/ttl/`](../../services/memory/ttl/) · 매니페스트: [`../k8s/memory-ttl/`](../k8s/memory-ttl/).

**이 문서 범위:** 만료 **short_term** / **audit** 월 파티션 **DROP**; 콜드 **episodic**는 archive 조율(`needs_archive`).  
**Non-goals:** Parquet archive 본문(`aura.tasks.memory.archive`) · Soft-delete-only 대량 `DELETE` · live 클러스터 apply 필수 · orphan embed 배치(후속) · `DROP … CASCADE` 자동화.

---

## 판정 (재고정 금지 — M1 수치)

파티션 exclusive upper bound `U`, 기준 `now()`(UTC):

| kind | 핫 | 액션 |
|------|----|------|
| `short_term` | 14일 | `U <= now()-14d` → **DROP** |
| `audit` | 12개월 | `U <= now()-12mo` → **DROP** |
| `episodic` | 24개월 | 핫 밖 + `archived≠true` → **`needs_archive`** (DROP 금지); archive 완료 후만 DROP |

금지: Soft delete만으로 핫 파티션 방치 · 미등록 테이블명 DROP · `CASCADE`.

---

## MQT

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.ttl` |
| consumer | `aura_memory_ttl` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.ttl.done` |
| errorTopic | `aura.events.memory.ttl.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| minReplicaCount | **0** (scale-to-zero) |
| 주기 | **일 1회**(UTC) — 스케줄러가 topic publish |

입력 envelope: §8 `id` + `payload.partitions[]` (`kind` · `name` · `upper_bound` · 선택 `archived`) · 선택 `payload.now`(테스트).  
성공 본문 `type: memory.ttl.done` · `payload.{dropped,needs_archive,kept}`.  
이름 허용: `memory_items_short_term_YYYY_MM` · `memory_items_episodic_YYYY_MM` · `memory_audit_YYYY_MM`.  
PG: **Pooler only** (`AURA_DATABASE_HOST` ⊆ `aura-pg-pooler`). DDL은 테넌트 RLS 밖(파티션 공유 스키마).

---

## 결정 로그

| 일자 | 결정 | 근거 |
|------|------|------|
| 2026-11-19 | M4 TTL job = DROP short_term/audit; episodic는 archive 선행 | §6.2.2 · policy 표 · Soft-delete-only 금지 |

---

## Commands

```bash
bash deploy/scripts/check-memory-ttl.sh
node services/memory/ttl/partition-plan.selftest.js
node services/memory/ttl/handler.selftest.js
```
