# `svc-control` 최소 resolve API · `source_meta`/`user_meta` 스키마 (M3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #6 · #11 · §2 · §3.3 · §6.1 · §7 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 첫 항목.  
DDL: [`../sql/control_meta.sql`](../sql/control_meta.sql).  
내부: [`../../services/control/DESIGN.md`](../../services/control/DESIGN.md).  
번들 객체 경로: [`object-store-content-ref.md`](object-store-content-ref.md) `bundles/` prefix.

**이 문서 범위:** 컨트롤 메타 **테이블 이름·컬럼** · resolve **요청/응답 wire** · 쓰기/읽기 소유 · cfg merge · 시크릿 규칙 · 관리 HTTP **경로 정본**(형태).  
**Non-goals:** tenants/ACL 테이블 · image/general deploy_mode · live Garage/Pooler CI 필수.  
관리 UI·activate checksum·`control_audit`: [`admin-ui-mvp.md`](admin-ui-mvp.md) (M6).  
**브리지 Warm 배포:** [`control-resolve-bridge.md`](control-resolve-bridge.md) · `deploy/k8s/control-resolve/` (minReplicas ≥ 2).

참고 저장소 `agent-runtime`의 deploy-api `/v1/resolve`는 **의도만** 참고한다 — 스키마·코드를 복사하지 않는다(AGENTS §2).

---

## 쓰기 · 읽기 소유

| 경로 | 소유 | 규칙 |
|------|------|------|
| `source_meta` / `user_meta` **쓰기** | **`svc-control`만** (관리 HTTP) | Function·Gateway·recall이 INSERT/UPDATE/DELETE 금지 (§1 #6) |
| resolve **읽기** | 런타임 Function → **`aura.rpc.control.resolve`** | Core RR · minReplicas ≥ 2 ([`control-resolve-bridge.md`](control-resolve-bridge.md)). PG는 **Pooler** + `set_config('app.tenant_id', $1, true)` (라이브 배선 후속) |
| 시크릿 | `user_meta.secrets_ref` **참조만** | plaintext 시크릿을 PG·NATS·로그에 두지 않음 (§9.2) |

---

## DDL 요약 (`control_meta.sql`)

### `source_meta` (immutable · versioned)

| 컬럼 | 타입 | 규칙 |
|------|------|------|
| `id` | UUID PK | |
| `tenant_id` | UUID NOT NULL | RLS 키 |
| `kind` | TEXT | `'agent'` \| `'mcp'` |
| `name` / `version` | TEXT | invoke 식별자 |
| `entrypoint` | TEXT | `module.path:attr` → factory |
| `bundle_uri` | TEXT | `s3://aura-content/tenants/{tenant_id}/bundles/…` |
| `checksum` | TEXT | `sha256:…` |
| `sig_uri` | TEXT NULL | 서명 객체(선택) |
| `config` | JSONB | 번들 기본 cfg (**runtime 금지** — 플랫폼 필드는 아래) |
| `runtime` | TEXT | `'nodejs'` \| `'python'` \| `'custom'` · **DEFAULT `nodejs`** · func-env 권위 |
| `status` | TEXT | `'pending'` \| `'active'` \| `'retired'` |
| `created_at` | TIMESTAMPTZ | |

UNIQUE `(tenant_id, kind, name, version)`. FORCE RLS + `app.tenant_id` GUC.

### `user_meta` (mutable · per principal)

| 컬럼 | 타입 | 규칙 |
|------|------|------|
| `id` | UUID PK | |
| `tenant_id` | UUID NOT NULL | RLS (source와 동일 테넌트) |
| `source_meta_id` | UUID FK → `source_meta(id)` ON DELETE CASCADE | |
| `principal_id` | TEXT | |
| `config` | JSONB | principal overlay |
| `secrets_ref` | TEXT NULL | 시크릿 스토어 키/이름 — **값 아님** |
| `updated_at` | TIMESTAMPTZ | |

UNIQUE `(source_meta_id, principal_id)`. FORCE RLS.

**M3 최소에서 제외:** `image`/`general` deploy_mode · `infra_meta` · `user_resource_access` — 필요 시 후속 티켓.

---

## Resolve wire (`aura.rpc.control.resolve`)

### 요청

식별자만 (§1 #11 · §7). 번들/config를 payload에 실지 않는다.

```json
{
  "tenant_id": "<uuid>",
  "kind": "agent",
  "name": "demo",
  "version": "1.0.0",
  "principal": { "id": "user-1", "tenant_id": "<uuid>" }
}
```

| 규칙 | 내용 |
|------|------|
| `kind` | `agent` \| `mcp` |
| `principal.tenant_id` | 반드시 요청 `tenant_id`와 **동일** (불일치 → 거부) |
| 조회 | `status = 'active'` 만 성공. `pending`/`retired` → error |

### 응답 (성공)

```json
{
  "type": "control.resolve.done",
  "source": { "id": "…", "tenant_id": "…", "kind": "agent", "name": "demo", "version": "1.0.0",
              "entrypoint": "main:factory", "bundle_uri": "s3://…", "checksum": "sha256:…",
              "sig_uri": null, "config": {}, "runtime": "nodejs", "status": "active", "created_at": "…" },
  "user": { "id": "…", "principal_id": "user-1", "config": {}, "secrets_ref": "k8s:secret/…", "updated_at": "…" },
  "cfg": {},
  "secrets_ref": "k8s:secret/…",
  "runtime": "nodejs"
}
```

| 필드 | 규칙 |
|------|------|
| `runtime` | `source.runtime` 복제 (top-level). Gateway 스탬프·브리지 라우팅용. **user_meta/cfg에 없음** |
| `cfg` | `mergeConfigs(source.config, user?.config)` — **1-depth 섹션 merge, user wins** |
| `user` | 해당 principal 행 없으면 `null`; 이때 `cfg = source.config`, `secrets_ref = null` |
| `secrets_ref` | ref 문자열만. **`secrets` plaintext 키 금지** |
| 실패 | `{ "type": "control.resolve.error", "error": "source_not_active" \| … }` |

헬퍼·셀프테스트: [`../../services/control/resolve.js`](../../services/control/resolve.js).

### factory 계약 (§1 #11)

런타임은 resolve 후 `factory(cfg, secrets)` 호출. `secrets`는 `secrets_ref`를 SecretResolver로 해석한 결과(브리지/런타임 DESIGN). 하위호환 zero-arg·1-arg 허용.

---

## 관리 HTTP (정본 · M6)

쓰기 소유=`svc-control` (`aura-control-admin`). 상세·화면·checksum: [`admin-ui-mvp.md`](admin-ui-mvp.md).

| 메서드 | 경로 | 용도 |
|--------|------|------|
| `GET` | `/v1/tenants` | Tenant picker (`DISTINCT` ∪ `AURA_ADMIN_TENANT_IDS`) |
| `POST` | `/v1/bundles/presign` | Garage PUT URL |
| `POST` | `/v1/sources` | INSERT `pending` (콘텐츠 불변; UNIQUE 409) |
| `GET` | `/v1/sources` · `/v1/sources/{kind}/{name}` | 목록·버전 타임라인 |
| `POST` | `/v1/sources/{id}/activate` | 서버 Garage sha256 후 `pending→active` |
| `POST` | `/v1/sources/{id}/retire` | `active→retired` · `reason` 필수 |
| `GET`/`PUT`/`DELETE` | `/v1/sources/{id}/overlays/{principal_id}` | `user_meta` (DELETE에 `reason`) |
| `GET` | `/v1/resolve?…` | 디버그 read — 생산 경로는 NATS RPC |

**폐기:** `PUT /v1/sources/{kind}/{name}/{version}` · `…/user-meta/…` 초안 경로.

`source_meta` 콘텐츠 컬럼 UPDATE 금지. `status`만 activate/retire. `control_audit` append-only([`../sql/control_meta.sql`](../sql/control_meta.sql)).

---

## 게이트

```bash
./deploy/scripts/check-svc-control-resolve.sh
node services/control/resolve.selftest.js
bash deploy/scripts/check-admin-ui-mvp.sh
```

PASS = DDL·문서·ARCHITECTURE 링크·merge/wire 셀프테스트 일치.
