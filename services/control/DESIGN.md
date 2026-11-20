# svc-control (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #6 · #11 · §2 · §3.3 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 resolve/브리지 · **M6 관리 HTTP + Pooler SELECT + audit**.  
스키마·wire: [`deploy/docs/svc-control-resolve.md`](../../deploy/docs/svc-control-resolve.md) · DDL [`deploy/sql/control_meta.sql`](../../deploy/sql/control_meta.sql).  
관리 UI: [`deploy/docs/admin-ui.md`](../../deploy/docs/admin-ui.md) · MVP [`admin-ui-mvp.md`](../../deploy/docs/admin-ui-mvp.md).  
브리지 Warm: [`deploy/docs/control-resolve-bridge.md`](../../deploy/docs/control-resolve-bridge.md) · [`deploy/k8s/control-resolve/`](../../deploy/k8s/control-resolve/).  
§9.2: [`deploy/docs/nats-mtls-secrets.md`](../../deploy/docs/nats-mtls-secrets.md).

**이 문서 범위:** 컨트롤 메타 쓰기 · resolve 읽기 · sync Function · **관리 HTTP** · **Pooler SELECT lookup** · **control_audit** · 시크릿 마스킹·TTL≤60s·NATS mTLS 가드.  
NATS 구독은 공용 [`../nats-rpc-bridge/DESIGN.md`](../nats-rpc-bridge/DESIGN.md) (replicas≥2).  
**Non-goals:** tenants/ACL 본구현 · 시크릿 스토어 본구현 · live cert/Garage/Pooler CI · MessageQueueTrigger · 서비스별 `*-rr`.

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-control`만 `source_meta`/`user_meta`/`control_audit` INSERT·status 전이 |
| 런타임 | Function은 resolve **read**만 (`aura.rpc.control.resolve`) |
| PG | **CloudNativePG Pooler** `aura-pg-pooler` · `set_config('app.tenant_id', $1, true)` 매 트랜잭션 |
| 관리 HTTP | `aura-control-admin` replicas≥2 · Bearer ops · `X-Aura-Tenant-Id` |
| 이미지 | `aura/control-admin:local` · `admin-*.js`+`tenant-tx.js`+`pg` 베이크 · `dev.orbstack.icon` · 소스 ConfigMap 금지 |
| 금지 | 세션 GUC · Function→PG 직접 · plaintext 시크릿 · invoke에 번들/config · RPC에 MQT · 콘텐츠 컬럼 UPDATE |

---

## Resolve 헬퍼

| 파일 | 역할 |
|------|------|
| `resolve.js` | `validateResolveRequest` · `mergeConfigs` · `buildResolveResponse` |
| `bridge.js` | stub / injectable `lookup` → `buildResolveResponse` |
| `tenant-tx.js` | `withTenantTx` — `set_config(..., true)` only |
| `pooler-lookup.js` | Pooler SELECT → `{source,user}` (active only) |
| `admin-http.js` | 관리 HTTP 라우트 핸들러 (presign·sources·activate·overlays·**GET audit**) |
| `admin-entrypoint.js` | 생산 Pooler DSN 배선 · `createAdminServer` |
| `secrets-mask.js` | `maskSecrets` |
| `secrets-cache.js` | TTL≤60s · rotate 무효화 |
| `nats-tls.js` | mTLS 클라이언트 가드 |

`cfg` = 1-depth section merge, user wins. 응답에 `secrets` 객체 없음.

---

## Resolve Function (sync poolmgr · via 공용 NATS 브리지)

| 항목 | 값 |
|------|-----|
| subject | `aura.rpc.control.resolve` |
| NATS | `aura-nats-rpc-bridge` · queue `aura-rpc-bridge` |
| Function | `aura-control-resolve` · **poolmgr** · env `aura-nodejs-sync` (`poolsize ≥ 2`) |
| lookup | injectable · 생산=`createPoolerLookup` |
| 금지 | MessageQueueTrigger · JetStream lag · 서비스별 `*-rr` |

---

## 관리 HTTP (내부)

| 규칙 | 내용 |
|------|------|
| INSERT | `status=pending` |
| activate | Garage GetObject → sha256 == row.checksum → `pending→active` + audit |
| retire | `active→retired` + `reason` + audit |
| overlays | PUT upsert · DELETE+reason · audit |
| audit | `GET /v1/audit` · limit·cursor · RLS SELECT |
| tenants | DISTINCT ∪ `AURA_ADMIN_TENANT_IDS` |
| 콘텐츠 | UPDATE 경로 없음 |
| Phase 2 quota | HTTP→`aura.rpc.gateway.quota`→Gateway만 · **KV 직접 금지** |

---

## Commands

```bash
bash deploy/scripts/check-svc-control-resolve.sh
bash deploy/scripts/check-control-resolve-bridge.sh
bash deploy/scripts/check-nats-mtls-secrets.sh
bash deploy/scripts/build-admin-images.sh
bash deploy/scripts/check-admin-ui.sh
bash deploy/scripts/check-admin-ui-mvp.sh
node services/control/resolve.selftest.js
node services/control/bridge.selftest.js
node services/control/pooler-lookup.selftest.js
node services/control/admin-http.selftest.js
node services/control/secrets-mask.selftest.js
node services/control/secrets-cache.selftest.js
node services/control/nats-tls.selftest.js
```
