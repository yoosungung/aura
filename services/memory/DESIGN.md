# svc-memory (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#5 · §2.1 · §3.2 · §6.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (store MQT + `set_config`) · embed/recall 본문은 M2.  
DDL: [`deploy/sql/`](../../deploy/sql/) · 활성 핀: [`deploy/docs/memory-embedding-active.md`](../../deploy/docs/memory-embedding-active.md).

**이 문서 범위:** `svc-memory` **store** 경로 — Fission MQT(`aura.tasks.memory.store`) · Pooler DSN · **매 트랜잭션** `SELECT set_config('app.tenant_id', $1, true)` (`is_local=true`).  
**Non-goals (M1):** embed/recall/consolidate/ttl/archive **본구현** · TEI 배포 · capture Function(→ [`../memory-capture/DESIGN.md`](../memory-capture/DESIGN.md)) · 타 스키마 재작업 · live 클러스터 apply 필수(정적 게이트만).

수치·모델 발명 금지 — 생산 임베딩은 이미 `BAAI/bge-m3:1` 핀. store는 `memory_items` 적재만(임베딩 INSERT는 embed 태스크).

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-memory`만 `memory_*` INSERT/UPDATE/DELETE (§1 #5) |
| 실행 계급 | **async** MQT · `minReplicaCount=0` |
| PG | **CloudNativePG Pooler**만 — host `aura-pg-pooler…` (`AURA_DATABASE_HOST`). primary/Pod IP 금지 |
| 테넌트 GUC | 매 트랜잭션 시작: `SELECT set_config('app.tenant_id', $1, true)` |
| 금지 | `set_config(..., false)` · 세션 `SET app.tenant_id` · 트랜잭션 밖 테넌트 상태 의존 |

---

## Store MQT (§3.2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.store` |
| consumer | `aura_memory_store` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.stored` |
| errorTopic | `aura.events.memory.store.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/memory-store/`](../../deploy/k8s/memory-store/) |

입력 envelope: §8 (`id` 멱등 키 · `tenant_id` · `payload` / `content_ref`).  
M1 스켈레톤: `tenant_id` 검증 → `withTenantTx` → (stub) idempotent upsert 자리 · 성공 시 `type: memory.stored` 본문. 실 DDL INSERT·멱등 UNIQUE는 동일 헬퍼 위에서 확장(체크는 GUC 경로만 고정).

---

## 트랜잭션 헬퍼

`services/memory/store/tenant-tx.js` — `BEGIN` → `set_config('app.tenant_id', $1, true)` → work → `COMMIT`/`ROLLBACK`.  
`handler.js`는 이 헬퍼만 경유한다. 세션 GUC·pool 재사용 테넌트 잔존을 두지 않는다.

---

## Commands

```bash
bash deploy/scripts/check-memory-store.sh          # DESIGN + MQT + set_config(..., true) + selftests
node services/memory/store/tenant-tx.selftest.js   # fake client: true before work, never false
node services/memory/store/handler.selftest.js     # MQT handler → withTenantTx
```

---

## 관련 링크

- §2.1 Pooler · §3.2 store subject · Pooler 스모크 [`deploy/docs/pg-pooler-smoke-plan.md`](../../deploy/docs/pg-pooler-smoke-plan.md)
- ROADMAP M1 «services/memory/DESIGN.md + store MQT»
