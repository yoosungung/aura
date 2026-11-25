# 관리 UI (ops-only · M6 → M6.1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #1·#6·#11 · §2 · §2.2 · §6.1.1 · §8 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M6 · **M6.1**.  
DDL: [`../sql/control_meta.sql`](../sql/control_meta.sql).  
resolve wire: [`svc-control-resolve.md`](svc-control-resolve.md).  
내부: [`../../services/control/DESIGN.md`](../../services/control/DESIGN.md) · [`../../services/admin-ui/DESIGN.md`](../../services/admin-ui/DESIGN.md).  
1차 MVP 스냅샷: [`admin-ui-mvp.md`](admin-ui-mvp.md) (역사 참조 · 정본은 이 문서).

**이 문서 범위:** 플랫폼 ops Admin UI · 관리 대상 인벤토리 · PG SoR vs NATS KV · React 스택 · `svc-control` 관리 HTTP · 번들 presign/activate · Tenant picker · `control_audit` · Phase 2 quota 경로.  
**Non-goals:** ACL/membership · 테넌트 admin SSO/OIDC · 과금 SPA · DLQ/PITR/erase 콘솔 · Chat UI · Gateway 대화면 · memory TTL/HNSW Admin 쓰기 · control-admin의 KV 직접 접속 · Admin UI→Gateway HTTP · quota **한도** 수정 UI.

---

## 저장소 경계

| 계층 | 역할 | Admin UI |
|------|------|----------|
| **PostgreSQL** (`tenant_meta` / `source_meta` / `user_meta` / `control_audit`) | Durable SoR · RLS · audit | 쓰기·읽기 정본. `aura-control-admin` HTTP만 |
| **NATS JetStream KV** (`quota.{tenant_id}`) | Gateway 공유 런타임 상태. **KV get/CAS/reset = Gateway만** | SoR 아님. Phase 2: UI→control-admin HTTP→`aura.rpc.gateway.quota`→Gateway→KV |
| **프로세스 캐시** (`secrets-cache` TTL≤60s) | OpenBao ref 가속 | UI 비대상 · plaintext 금지 |
| **스트림·env·하드코드 정책** | retention / TTL / inject 예산 등 | 인벤토리만 · UI 쓰기 금지 |

**컨트롤 설정을 KV에 두지 않는다. control-admin이 KV를 열지 않는다.**

### Phase 2 quota read/reset

```text
Admin UI
  → HTTP  GET /v1/quotas/{tenant_id}  |  POST /v1/quotas/{tenant_id}/reset
aura-control-admin
  → NATS Core RR  aura.rpc.gateway.quota
Gateway
  → NATS KV  quota.{tenant_id}
```

---

## 관리 대상 인벤토리

NATS **subject 자체는 관리 대상이 아님**. 관리하는 것은 subject로 흘러가는 메타·상태·정책 값.

### Phase 1 (구현)

| 리소스 | 필드/동작 | 저장 |
|--------|-----------|------|
| `tenant_meta` | `id` + `display_name` · create/rename | PG |
| Tenant picker | `tenant_meta` ∪ `DISTINCT` ∪ UUID 입력 | PG |
| `source_meta` | kind/name/version/runtime/entrypoint/bundle/checksum/config · pending→active→retired | PG |
| Bundles | presign → Garage PUT → activate 서버 sha256 | Garage + PG |
| `user_meta` overlays | principal `config` + `secrets_ref` only | PG |
| `control_audit` | activate/retire/overlay append · **GET `/v1/audit`** | PG |

### Phase 2+ 카탈로그 (문서만)

| 영역 | 예 | 저장 | UI |
|------|----|------|-----|
| Gateway Fair Queue | `quota.{tenant_id}` 조회·리셋 | KV=Gateway 단독 · 한도는 코드→PG `tenant_plan` 후보 | 읽기+리셋 (**한도 수정 UI = ROADMAP M6.2 `[~]` 범위 밖**) |
| LLM Gateway | RL · Fallback · usage | 코드/주입 → 정책 PG 후보 | 읽기 우선 |
| Memory 정책 | TTL 14d/24mo/12mo · embed pin · graph · inject 2048 | 문서/env | 쓰기 금지 |
| Streams | `AURA_*` retention · MaxDeliver | `ensure-streams.sh` | 읽기/런북 |
| Compliance/DLQ/PITR | erase · Replay | 태스크/CLI | 별 콘솔 |

---

## 경계 (런타임)

| 경로 | 규칙 |
|------|------|
| 쓰기 | Admin UI → **`aura-control-admin` HTTP** → Pooler (`set_config(..., true)`) · Garage |
| 런타임 읽기 | Function → **`aura.rpc.control.resolve`** (NATS) → Pooler SELECT — UI가 resolve subject를 쓰지 않음 |
| 인가 | Bearer **ops-only** · `X-Aura-Tenant-Id` 필수(tenants·healthz 제외) |
| 시크릿 | `secrets_ref`만 · plaintext 금지 · `maskSecrets` |

---

## `source_meta` 상태 머신

| 규칙 | 내용 |
|------|------|
| 콘텐츠 불변 | `entrypoint`/`bundle_uri`/`checksum`/`sig_uri`/`config`/`runtime`/`kind`/`name`/`version` — INSERT 후 UPDATE 금지 · 변경=새 version |
| status 예외 | `pending → active` (activate) · `active → retired` (retire) 만 |
| INSERT | 항상 `status=pending` |
| resolve | `status=active` 만 성공 |
| config | `runtime` 키 금지 |

---

## 관리 HTTP

Deployment `aura-control-admin` · ns `aura` · replicas≥2.  
이미지 `aura/control-admin:local` · `aura/admin-ui:local` (`deploy/scripts/build-admin-images.sh`). 앱 소스와 SPA `dist/`는 이미지에 굽는다.

| 메서드 | 경로 | 용도 |
|--------|------|------|
| `GET` | `/v1/tenants` | picker 목록 `{ id, display_name }` (`tenant_meta` ∪ DISTINCT) |
| `POST` | `/v1/tenants` | create/upsert · body `{ display_name, id? }` · **id 생략 시 서버 UUID 생성** · audit |
| `PATCH` | `/v1/tenants/{id}` | rename `display_name` · audit |
| `GET` | `/v1/quotas/{tenant_id}` | Phase 2 조회 · Gateway RR injectable · 한도 수정 금지 |
| `POST` | `/v1/quotas/{tenant_id}/reset` | Phase 2 리셋 · Gateway RR injectable |
| `POST` | `/v1/bundles/presign` | `{ upload_url, bundle_uri, headers }` |
| `POST` | `/v1/sources` | INSERT pending · UNIQUE 409 |
| `GET` | `/v1/sources` | 목록 |
| `GET` | `/v1/sources/{kind}/{name}` | 버전 타임라인 |
| `POST` | `/v1/sources/{id}/activate` | Garage sha256 서버 대조 후 active |
| `POST` | `/v1/sources/{id}/retire` | body `reason` 필수 |
| `GET` | `/v1/sources/{id}/overlays` | overlays |
| `PUT` | `/v1/sources/{id}/overlays/{principal_id}` | upsert |
| `DELETE` | `/v1/sources/{id}/overlays/{principal_id}` | `reason` 필수 |
| `GET` | `/v1/audit` | `control_audit` · `limit`·`cursor`·`action`(optional prefix/exact) · RLS |
| `GET` | `/healthz` | ok |

### activate checksum

1. `POST /v1/bundles/presign` → 클라이언트 Garage PUT  
2. `POST /v1/sources` — body checksum = 기대값 · `pending`  
3. `POST …/activate` — Garage `GetObject` → sha256 → 행 checksum 일치 시에만 `active`  
4. 불일치·부재·`status≠pending` → 거부(422/409)

### Tenant picker / `tenant_meta`

`GET /v1/tenants` = `tenant_meta` ∪ `DISTINCT source_meta.tenant_id` ∪ UI UUID 입력.  
응답 행: `{ id, display_name }` — 메타 없으면 `display_name=null`.  
`POST`는 `display_name`만으로 생성(UUID 자동) · `id` 주면 upsert. `PATCH`는 rename. OIDC/SSO·ACL·env CSV seed 비범위.

### `control_audit`

append-only · FORCE RLS. activate / retire / overlay upsert·DELETE / source.create 시 INSERT.  
컬럼: `actor`, `action`, `resource_type`, `resource_id`, `reason`, `at`.  
`GET /v1/audit`로 조회(읽기 전용).

---

## 프론트 스택 (M6.1)

| 관심사 | 선택 |
|--------|------|
| UI | React 19 + TypeScript |
| 빌드 | Vite (정적 `dist/`) |
| 스타일 | Tailwind CSS v4 |
| 컴포넌트 | shadcn/ui (Radix) |
| 서버 상태 | TanStack Query v5 |
| 클라이언트 상태 | Zustand (tenant·Bearer·셸) |
| 폼·검증 | React Hook Form + Zod |
| 라우팅 | React Router v7 |
| 테이블 | TanStack Table |
| HTTP | `fetch` + `X-Aura-Tenant-Id` · `Authorization` |

호출: `AURA_CONTROL_ADMIN_URL` → `aura-control-admin`만. NATS 클라이언트·`aura.rpc.control.resolve` 금지.

---

## 화면 (Phase 1)

| 화면 | 역할 |
|------|------|
| Session 셸 | Bearer · health · **헤더 Tenant switcher**(`display_name`) · toast |
| Tenant | `tenant_meta` alias 등록/rename · UUID paste advanced |
| Quotas | 조회·리셋 (한도 수정 금지) |
| Sources | kind/name/version/runtime/status · activate/retire(**confirm dialog**) |
| Bundle 등록 | presign → PUT → sources pending → activate |
| Overlays | upsert · delete(**confirm + reason**) · `secrets_ref`만 |
| Audit | 필터·커서 목록 (read-only) |

### UX (Sprint A · production-lean)

| 규칙 | 내용 |
|------|------|
| 파괴적 액션 | Retire / Overlay Delete / Activate → **ConfirmDialog** (대상 라벨 명시). reason은 다이얼로그 안에서만(상시 필드 금지) |
| Activate | reason 불필요 · checksum/id 요약 후 확인 |
| Tenant | 헤더 switcher가 주 경로 · 페이지 Load 버튼 없음(자동 fetch) · UUID paste는 Tenant 페이지 advanced |
| 피드백 | toast · `formatApiError` (JSON dump 금지) |

### UX (Sprint B)

| 규칙 | 내용 |
|------|------|
| Bundles | 등록 성공 후 **Activate now** / Sources 이동 CTA |
| Sources | status·kind 필터 · 행/그룹에서 `GET /v1/sources/{kind}/{name}` 버전 타임라인 |
| Overlays | 목록 중심 · New/Edit **drawer** · Delete는 ConfirmDialog 유지 |
| Audit | `GET /v1/audit?action=` 서버 필터 · source/overlay 리소스 딥링크 |
| Tenant alias | `tenant_meta` DDL + POST/PATCH · 헤더/목록에 `display_name` |
| Quotas | 조회·리셋만 (한도 수정=ROADMAP `[~]`) |

### 표시 규칙 (사람 우선)

API·세션 값은 그대로 UUID / `bundle_uri` / checksum. UI 첫 줄만 사람이 읽는 라벨로 둔다.

| 규칙 | 내용 |
|------|------|
| 식별자 | 화면에는 `shortId` (앞 8자…) · 전체 값은 title·복사 |
| Source | 선택·목록 라벨 = `kind / name / version · status` · 값은 `id` |
| Tenant | tenants DDL 없음 → 표시도 UUID 단축 · 직접 입력 유지 |
| Bundle | 파일 선택 → 브라우저 `sha256:` 계산 → Presign → Garage PUT → pending 생성 · `bundle_uri`/checksum은 읽기 전용 |
| Overlay | source는 Sources 목록 select · New/Edit drawer · Sources→`/overlays?source=` |
| Config | 키·값 행 폼 → 객체 · 빈 행=생략 · `runtime` 키 금지(스키마) |
| 시크릿 | `secrets_ref` 입력만 · plaintext 금지 |

---

## 검증

```bash
bash deploy/scripts/build-admin-images.sh
bash deploy/scripts/check-admin-ui.sh
bash deploy/scripts/check-admin-ui-mvp.sh
bash deploy/scripts/apply-admin-ui.sh
node services/control/admin-http.selftest.js
node services/control/pooler-lookup.selftest.js
node services/admin-ui/ui.selftest.cjs
cd services/admin-ui && npm test && npm run build
# kubectl -n aura port-forward svc/aura-admin-ui 18080:8080
# open http://localhost:18080  Bearer=ops-dev-token
```

PASS = 문서·DDL·API·상태머신·서버 checksum·audit GET·Pooler lookup·React Admin UI 계약 일치. live Garage/Pooler = Non-goal(injectable).
