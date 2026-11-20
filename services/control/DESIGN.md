# svc-control (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #6 · #11 · §2 · §3.3 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — 최소 resolve API/스키마 + **`aura.rpc.control.resolve` 브리지** + **NATS mTLS·시크릿 마스킹/TTL 캐시**.  
스키마·wire 정본: [`deploy/docs/svc-control-resolve.md`](../../deploy/docs/svc-control-resolve.md) · DDL [`deploy/sql/control_meta.sql`](../../deploy/sql/control_meta.sql).  
브리지 Warm: [`deploy/docs/control-resolve-bridge.md`](../../deploy/docs/control-resolve-bridge.md) · [`deploy/k8s/control-resolve/`](../../deploy/k8s/control-resolve/).  
§9.2 와이어: [`deploy/docs/nats-mtls-secrets.md`](../../deploy/docs/nats-mtls-secrets.md) · [`deploy/k8s/nats-mtls/`](../../deploy/k8s/nats-mtls/).

**이 문서 범위:** 컨트롤 메타 쓰기 경계 · resolve 읽기 헬퍼 · **sync Function**(`aura-control-resolve` poolmgr) · Pooler/GUC 전제 · **시크릿 마스킹·TTL≤60s 캐시·NATS mTLS 클라이언트 가드**.  
NATS 구독은 공용 [`../nats-rpc-bridge/DESIGN.md`](../nats-rpc-bridge/DESIGN.md) (replicas≥2).  
**Non-goals (본 슬라이스):** 라이브 Pooler SELECT 본배선 · HTTP admin 서버 · tenants/ACL · 시크릿 스토어 본구현 · live cert CI · 번들 업로드 · MessageQueueTrigger · 서비스별 `*-rr`.

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
| `secrets-mask.js` | `maskSecrets` — 로그·OTel용 시크릿 필드 마스킹 (§9.2; M4 attrs는 [`../otel/`](../otel/)가 재사용) |
| `secrets-cache.js` | `createSecretsCache` TTL≤60s · `aura.events.control.secrets.rotated` 무효화 |
| `nats-tls.js` | `buildNatsTlsOptions` · `assertNatsMtlsConnect` — 클라이언트 mTLS |

`cfg` = 1-depth section merge, user wins. 응답에 `secrets` 객체 없음.

정본: [`deploy/docs/nats-mtls-secrets.md`](../../deploy/docs/nats-mtls-secrets.md) · `check-nats-mtls-secrets.sh`.

---

## Resolve Function (sync poolmgr · via 공용 NATS 브리지)

| 항목 | 값 |
|------|-----|
| subject | `aura.rpc.control.resolve` |
| NATS | `aura-nats-rpc-bridge` · queue `aura-rpc-bridge` |
| Function | `aura-control-resolve` · **poolmgr** · env `aura-nodejs-sync` (`poolsize ≥ 2`) |
| handler | `bridge.js` — stub / injectable lookup → `buildResolveResponse` |
| 금지 | MessageQueueTrigger · JetStream lag · 서비스별 `*-rr` |

---

## 후속 (별 티켓)

1. 브리지 → Pooler SELECT 본배선 (`withTenantTx` + FORCE RLS)  
2. 관리 HTTP — source 등록·user_meta upsert  
3. 시크릿 resolve Pooler 본배선 (mask/TTL·mTLS overlay는 M3 슬라이스 완료)

---

## Commands

```bash
bash deploy/scripts/check-svc-control-resolve.sh
bash deploy/scripts/check-control-resolve-bridge.sh
bash deploy/scripts/check-nats-mtls-secrets.sh
node services/control/resolve.selftest.js
node services/control/bridge.selftest.js
node services/control/secrets-mask.selftest.js
node services/control/secrets-cache.selftest.js
node services/control/nats-tls.selftest.js
```
