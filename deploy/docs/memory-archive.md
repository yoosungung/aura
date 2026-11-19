# `aura.tasks.memory.archive` — 콜드 episodic Parquet (M4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #8 · §3.2 · **§6.2.2** · **§8**.  
수치: [`memory-ttl-policy.md`](memory-ttl-policy.md) (episodic 핫 **24개월**).  
TTL 조율: [`memory-ttl-drop.md`](memory-ttl-drop.md) (`needs_archive`).  
경로: [`object-store-content-ref.md`](object-store-content-ref.md) (`aura-content` · `archive/`).  
코드: [`services/memory/archive/`](../../services/memory/archive/) · 매니페스트: [`../k8s/memory-archive/`](../k8s/memory-archive/).

**이 문서 범위:** 콜드 **episodic** 월 파티션 → Object Storage **Parquet** → **DETACH/DROP** · 완료 이벤트.  
**Non-goals:** live Garage SDK/provision · object_gc · OTel · erase · `pg_parquet` 확장 필수 · Soft-delete-only · short_term/audit DROP(TTL 담당).

---

## 순서 (필수)

1. **export_parquet** — 파티션 행 → Parquet(유닛= `PAR1` stub; 라이브=COPY/pg_parquet 후속 교체 가능)
2. **put_object** — 버킷 `aura-content`, 키 `tenants/{tenant_id}/archive/episodic/{yyyy}/{mm}/{partition}.parquet`
3. **verify** — Put 성공(etag) 없으면 **DETACH/DROP 금지**
4. **detach** — `ALTER TABLE memory_items_episodic DETACH PARTITION …`
5. **drop** — `DROP TABLE IF EXISTS … RESTRICT` (CASCADE 자동화 금지)

TTL이 `needs_archive`로 넘긴 대상만(또는 동일 콜드 판정) 처리. 핫 창 안이면 `skip_hot`.

---

## MQT

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.archive` |
| consumer | `aura_memory_archive` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.archived` |
| errorTopic | `aura.events.memory.archive.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| minReplicaCount | **0** |

입력: §8 `id` · `tenant_id` · `payload.partitions[]` (`name` · `upper_bound` · 선택 `row_count`).  
성공 본문 `type: memory.archived`.  
이름 허용: `memory_items_episodic_YYYY_MM` 만.  
PG: Pooler only.

---

## Commands

```bash
bash deploy/scripts/check-memory-archive.sh
node services/memory/archive/plan.selftest.js
node services/memory/archive/handler.selftest.js
```
