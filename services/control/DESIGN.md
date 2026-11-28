# svc-control (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #6 · #11 · §2 · §3.3 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 resolve/브리지 · **M6 관리 HTTP + Pooler SELECT + audit**.  
스키마·wire: [`deploy/docs/svc-control-resolve.md`](../../deploy/docs/svc-control-resolve.md) · DDL [`deploy/sql/control_meta.sql`](../../deploy/sql/control_meta.sql).  
관리 UI: [`deploy/docs/admin-ui.md`](../../deploy/docs/admin-ui.md) · MVP [`admin-ui-mvp.md`](../../deploy/docs/admin-ui-mvp.md).  
브리지 Warm: [`deploy/docs/control-resolve-bridge.md`](../../deploy/docs/control-resolve-bridge.md) · [`deploy/k8s/control-resolve/`](../../deploy/k8s/control-resolve/).  
§9.2: [`deploy/docs/nats-mtls-secrets.md`](../../deploy/docs/nats-mtls-secrets.md).

**이 문서 범위:** 컨트롤 메타 쓰기 · resolve 읽기 · sync **Deployment** · **관리 HTTP** · **Pooler SELECT lookup** · **control_audit** · 시크릿 마스킹·TTL≤60s·NATS mTLS 가드.  
NATS 구독은 공용 [`../nats-rpc-bridge/DESIGN.md`](../nats-rpc-bridge/DESIGN.md) (replicas≥2 → Service HTTP).  
하드코드 런북: [`deploy/docs/memory-control-hardcode.md`](../../deploy/docs/memory-control-hardcode.md).  
**Non-goals:** tenants/ACL 본구현 · 시크릿 스토어 본구현 · live cert/Garage/Pooler CI · MessageQueueTrigger · 서비스별 `*-rr`.

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-control`만 `source_meta`/`user_meta`/`control_audit` INSERT·status 전이 |
| 런타임 | resolve Deployment는 **read**만 (`aura.rpc.control.resolve`) |
| PG | **CloudNativePG Pooler** `aura-pg-pooler` · `set_config('app.tenant_id', $1, true)` 매 트랜잭션 |
| 관리 HTTP | `aura-control-admin` replicas≥2 · Bearer ops · `X-Aura-Tenant-Id` |
| 이미지 | `aura/control-admin:local` · `aura/control-resolve:local` · Rust distroless · `dev.orbstack.icon` |
| Rust | `aura-control` · resolve wire + admin · `parity_tests.rs` · **Pooler=`StubPooler`** · live DSN/activate=후속 |
| 금지 | 세션 GUC · resolve 파드→PG 직접(lookup inject만) · plaintext 시크릿 · invoke에 번들/config · RPC에 MQT · 콘텐츠 컬럼 UPDATE |

---

## Resolve 헬퍼

| 파일 | 역할 |
|------|------|
| `src/lib.rs` | `validate_resolve_request` · `merge_configs` · `build_resolve_response` · `resolve_with_pooler` |
| `src/bin/aura-control-resolve.rs` | sync HTTP RPC (`/rpc`) · StubPooler / injectable lookup |
| `src/main.rs` | `aura-control-admin` 관리 HTTP |
| `crates/aura-tenant-tx` | `SET_TENANT_GUC_SQL` — `set_config(..., true)` only |
| `crates/aura-otel` | `mask_secrets` |

`cfg` = 1-depth section merge, user wins. 응답에 `secrets` 객체 없음.

---

## Resolve Deployment (sync · via 공용 NATS 브리지 → Service HTTP)

| 항목 | 값 |
|------|-----|
| subject | `aura.rpc.control.resolve` |
| NATS | `aura-nats-rpc-bridge` · queue `aura-rpc-bridge` |
| Target | Deployment+Service `aura-control-resolve` · lab `replicas: 1` (HA ≥2) · ns `aura` |
| lookup | injectable · 생산=`createPoolerLookup` |
| 금지 | MessageQueueTrigger · JetStream lag · 서비스별 `*-rr` · Fission Function |

---

## 관리 HTTP (내부)

| 규칙 | 내용 |
|------|------|
| INSERT | `status=pending` |
| activate | nodejs/python: Garage GetObject → sha256 == row.checksum → `pending→active`. **custom**: Garage 스킵 · Function 마커만 확인 → `pending→active` + audit |
| custom create | `function`=Router 이름(접두사 allowlist) · `entrypoint` NULL · `bundle_uri`/`checksum` 서버 마커 · 업로드 금지 |
| bundle download | `GET …/sources/{id}/bundle` · s3 only · custom 거부 · base64 ≤8MiB · audit |
| retire | `active→retired` + `reason` + audit |
| overlays | PUT upsert · DELETE+reason · audit |
| audit | `GET /v1/audit` · limit·cursor·`action`(optional) · RLS SELECT |
| tenants | `tenant_meta` ∪ DISTINCT · POST(`display_name`, `id?` 자동 UUID) · PATCH rename |
| 콘텐츠 | UPDATE 경로 없음 |
| Phase 2 quota | `GET/POST …/quotas` · injectable `quotaLimiter`/`quotaRpc` · 한도 수정 금지 · **KV 직접 금지** |

---

## Commands

```bash
bash deploy/scripts/check-svc-control-resolve.sh
bash deploy/scripts/check-control-resolve-bridge.sh
bash deploy/scripts/check-memory-control-hardcode.sh
bash deploy/scripts/check-nats-mtls-secrets.sh
bash deploy/scripts/build-admin-images.sh
bash deploy/scripts/check-admin-ui.sh
bash deploy/scripts/check-admin-ui-mvp.sh
cargo test -p aura-control
docker build -f services/control/Dockerfile -t aura/control-admin:local .
docker build -f services/control/Dockerfile.resolve -t aura/control-resolve:local .
```
