# svc-control (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #6 · #11 · §2 · §3.3 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — 최소 resolve API/스키마 + **`aura.rpc.control.resolve` 브리지**.  
스키마·wire 정본: [`deploy/docs/svc-control-resolve.md`](../../deploy/docs/svc-control-resolve.md) · DDL [`deploy/sql/control_meta.sql`](../../deploy/sql/control_meta.sql).  
브리지 Warm: [`deploy/docs/control-resolve-bridge.md`](../../deploy/docs/control-resolve-bridge.md) · [`deploy/k8s/control-resolve/`](../../deploy/k8s/control-resolve/).

**이 문서 범위:** 컨트롤 메타 쓰기 경계 · resolve 읽기 헬퍼 · **Core RR 브리지**(minReplicas ≥ 2) · Pooler/GUC 전제.  
**Non-goals (본 슬라이스):** 라이브 Pooler SELECT 본배선 · HTTP admin 서버 · tenants/ACL · 시크릿 스토어 구현 · 번들 업로드 · MessageQueueTrigger. (`agent_invoke` MQT는 [`../agent-invoke/DESIGN.md`](../agent-invoke/DESIGN.md).)

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-control`만 `source_meta`/`user_meta` INSERT/UPDATE/DELETE |
| 런타임 | Function은 resolve **read**만 (`aura.rpc.control.resolve`) |
| PG | **CloudNativePG Pooler** `aura-pg-pooler` · `set_config('app.tenant_id', $1, true)` 매 트랜잭션 (라이브 배선 Non-goal) |
| 금지 | 세션 GUC · Function→PG 직접 · plaintext 시크릿 컬럼 · invoke payload에 번들/config 실어 보내기 · RPC에 MQT |

---

## Resolve 헬퍼

| 파일 | 역할 |
|------|------|
| `resolve.js` | `validateResolveRequest` · `mergeConfigs` · `buildResolveResponse` |
| `resolve.selftest.js` | wire·merge·active-only·secrets_ref-only 게이트 |

`cfg` = 1-depth section merge, user wins. 응답에 `secrets` 객체 없음.

---

## Bridge (Core RR · Warm)

| 항목 | 값 |
|------|-----|
| subject | `aura.rpc.control.resolve` |
| queue-group | `aura-control-resolve` |
| Deployment | `aura-control-resolve-rr` · **replicas ≥ 2** |
| Warm Function | `aura-control-resolve` · `newdeploy` · **MinScale ≥ 2** |
| handler | `bridge.js` — stub / injectable lookup → `buildResolveResponse` |
| 금지 | MessageQueueTrigger · JetStream lag ScaledObject |

---

## 후속 (별 티켓)

1. 브리지 → Pooler SELECT 본배선 (`withTenantTx` + FORCE RLS)  
2. 관리 HTTP — source 등록·user_meta upsert  
3. 시크릿 resolve + TTL 캐시 무효화 이벤트

---

## Commands

```bash
bash deploy/scripts/check-svc-control-resolve.sh
bash deploy/scripts/check-control-resolve-bridge.sh
node services/control/resolve.selftest.js
node services/control/bridge.selftest.js
```
