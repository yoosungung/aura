# `aura.tasks.memory.object_gc` — 고아 refs GC (M4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §3.1–§3.2 · **§8**.  
알고리즘 정본: [`object-store-orphan-gc.md`](object-store-orphan-gc.md) (M2).  
스케줄: [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md).  
경로: [`object-store-content-ref.md`](object-store-content-ref.md).  
코드: [`services/memory/src/handlers.rs`](../../services/memory/src/handlers.rs) · 매니페스트: [`../k8s/memory-object-gc/`](../k8s/memory-object-gc/).

**이 문서 범위:** List `refs/` · 90일 유예 · live 참조 스킵 · DeleteObject · 배치 100 · 멱등 키.  
**Non-goals:** live provision · `archive/`/`bundles/` GC · erase · 상시 Deployment.

---

## 동작

1. `ListObjects(bucket=aura-content, prefix=tenants/{tenant}/refs/)`
2. `LastModified < now()-90d` 후보만 (≤100)
3. `set_config('app.tenant_id', $1, true)` 후 `memory_items`/`memory_audit` metadata `content_ref` EXISTS → **SKIP**
4. 아니면 `DeleteObject` (404=성공)
5. `aura.events.memory.object_gc.done` / `.error`

멱등 envelope id: `object-gc:{tenant_id|all}:{yyyy-mm-dd}` (UTC).

---

## 실행 형태

| 필드 | 값 |
|------|-----|
| 실행 | **CronJob** `aura-memory-object-gc-cron` → `/aura-memory-object-gc` |
| 이미지 | `aura/memory-batch` |
| 주기 | UTC 일 1회 · `Forbid` |
| 상시 파드 | **없음** |

---

## Commands

```bash
bash deploy/scripts/check-object-store-orphan-gc.sh
cargo test -p aura-memory --lib object_gc
```
