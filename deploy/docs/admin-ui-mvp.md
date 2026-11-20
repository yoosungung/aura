# 관리 UI 1차 MVP (ops-only · M6) — 역사 스냅샷

**정본은 [`admin-ui.md`](admin-ui.md)다.** 본 문서는 M6 봉인 시점의 스냅샷·게이트 호환용이다.

계약·HTTP·상태머신·Tenant picker·`control_audit`·화면·검증: [`admin-ui.md`](admin-ui.md).  
내부: [`../../services/admin-ui/DESIGN.md`](../../services/admin-ui/DESIGN.md) · [`../../services/control/DESIGN.md`](../../services/control/DESIGN.md).

**Non-goals:** tenants/ACL 테이블 · 테넌트 admin SSO · 과금 SPA · DLQ/PITR/erase 콘솔 · Chat UI · Gateway 대화면 · live Garage/Pooler CI 필수.

---

## 경계

| 경로 | 규칙 |
|------|------|
| 쓰기 | Admin UI → **`aura-control-admin` HTTP** → Pooler (`set_config(..., true)`) · Garage |
| 런타임 읽기 | Function → **`aura.rpc.control.resolve`** (NATS) → Pooler SELECT — UI가 resolve subject를 쓰지 않음 |
| 인가 | Bearer **ops-only** · `X-Aura-Tenant-Id` 필수 |
| 시크릿 | `secrets_ref`만 · plaintext 금지 · `maskSecrets` |

---

## `source_meta` 상태 머신

| 규칙 | 내용 |
|------|------|
| 콘텐츠 불변 | `entrypoint`/`bundle_uri`/`checksum`/`sig_uri`/`config`/`runtime`/`kind`/`name`/`version` — INSERT 후 UPDATE 금지 · 변경=새 version |
| status 예외 | `pending → active` (activate) · `active → retired` (retire) 만 |
| INSERT | 항상 `status=pending` |
| resolve | `status=active` 만 성공 |

---

## 관리 HTTP

Deployment `aura-control-admin` · ns `aura` · replicas≥2.  
이미지 `aura/control-admin:local` (소스 ConfigMap 금지). SPA는 `aura/admin-ui:local`.

| 메서드 | 경로 | 용도 |
|--------|------|------|
| `GET` | `/v1/tenants` | picker 목록 |
| `POST` | `/v1/bundles/presign` | `{ upload_url, bundle_uri, headers }` |
| `POST` | `/v1/sources` | INSERT pending · UNIQUE 409 |
| `GET` | `/v1/sources` | 목록 |
| `GET` | `/v1/sources/{kind}/{name}` | 버전 타임라인 |
| `POST` | `/v1/sources/{id}/activate` | Garage sha256 서버 대조 후 active |
| `POST` | `/v1/sources/{id}/retire` | body `reason` 필수 |
| `GET` | `/v1/sources/{id}/overlays` | overlays |
| `PUT` | `/v1/sources/{id}/overlays/{principal_id}` | upsert |
| `DELETE` | `/v1/sources/{id}/overlays/{principal_id}` | `reason` 필수 |
| `GET` | `/healthz` | ok |

### activate checksum

1. `POST /v1/bundles/presign` → 클라이언트 Garage PUT  
2. `POST /v1/sources` — body checksum = 기대값 · `pending`  
3. `POST …/activate` — `svc-control`이 Garage `GetObject` → sha256 계산 → 행 checksum과 일치할 때만 `active`  
4. 불일치·부재·`status≠pending` → 거부(422/409) · status 유지

### Tenant picker

`GET /v1/tenants` = `DISTINCT tenant_id FROM source_meta` ∪ env/ConfigMap **`AURA_ADMIN_TENANT_IDS`**(CSV UUID) ∪ UI **직접 UUID 입력**. tenants DDL 없음.

### `control_audit`

append-only · FORCE RLS. activate / retire / overlay upsert·DELETE 시 INSERT. 컬럼: `actor`, `action`, `resource_type`, `resource_id`, `reason`, `at`.

---

## 화면

| 화면 | 역할 |
|------|------|
| Tenant picker | §목록 + UUID 입력 · 배너에 활성 tenant 상시 |
| Sources | kind/name/version/runtime/status |
| Source 상세 | 버전 타임라인 · activate / retire(reason) |
| Bundle 등록 | presign → PUT → sources pending → activate |
| Overlays | upsert · delete(reason) · `secrets_ref`만 |

---

## 검증

```bash
bash deploy/scripts/check-admin-ui-mvp.sh
bash deploy/scripts/check-admin-ui.sh
node services/control/admin-http.selftest.js
node services/control/pooler-lookup.selftest.js
```

PASS = 문서·DDL·API·상태머신·서버 checksum·audit·Pooler lookup·Admin UI 계약 일치. live Garage/Pooler 클러스터는 Non-goal(injectable).
