# `aura.tasks.memory.ttl` — 월 파티션 DROP (M4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #8 · §3.2 · **§6.2.2**.  
수치 정본: [`memory-ttl-policy.md`](memory-ttl-policy.md) (M1).  
스케줄: [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md).  
코드: [`services/memory/src/handlers.rs`](../../services/memory/src/handlers.rs) · 매니페스트: [`../k8s/memory-ttl/`](../k8s/memory-ttl/).

**이 문서 범위:** 만료 **short_term** / **audit** 월 파티션 **DROP**; 콜드 **episodic**는 archive 조율(`needs_archive`).  
**Non-goals:** Parquet archive 본문 · Soft-delete-only 대량 `DELETE` · live 클러스터 apply 필수 · `DROP … CASCADE` 자동화 · 상시 Deployment.

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

## 실행 형태

| 필드 | 값 |
|------|-----|
| 실행 | **CronJob** `aura-memory-ttl-cron` → `/aura-memory-ttl` |
| 이미지 | `aura/memory-batch` |
| 주기 | UTC 일 1회 (`0 0 * * *`) · `concurrencyPolicy: Forbid` |
| 이벤트 | `aura.events.memory.ttl.done` / `.error` |
| 상시 파드 | **없음** |

입력: `payload.partitions[]` (`kind` · `name` · `upper_bound` · 선택 `archived`) · 선택 `payload.now`(테스트).  
성공 본문 `type: memory.ttl.done` · `payload.{dropped,needs_archive,kept}`.  
이름 허용: `memory_items_short_term_YYYY_MM` · `memory_items_episodic_YYYY_MM` · `memory_audit_YYYY_MM`.  
PG: **Pooler only**. DDL은 테넌트 RLS 밖(파티션 공유 스키마).

Subject 이름 `aura.tasks.memory.ttl`는 이벤트/문서 식별용으로 유지(JetStream durable consumer **아님**).

---

## Commands

```bash
bash deploy/scripts/check-memory-ttl.sh
cargo test -p aura-memory --lib batch_payload
```
