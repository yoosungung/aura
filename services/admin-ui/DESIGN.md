# Admin UI (ops-only · M6.1 React)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §2 · §6.1.1.  
정본: [`deploy/docs/admin-ui.md`](../../deploy/docs/admin-ui.md).  
MVP 스냅샷: [`deploy/docs/admin-ui-mvp.md`](../../deploy/docs/admin-ui-mvp.md).  
API: [`../control/admin-http.js`](../control/admin-http.js).

**이 문서 범위:** 플랫폼 ops SPA — Tenant picker · Sources · Bundle 등록 · overlays · Audit.  
**Non-goals:** 테넌트 self-serve · Chat UI · 과금 SPA · OIDC 본구현(Bearer 토큰 입력만) · NATS 클라이언트 · Gateway HTTP · KV 직접 접속.

---

## 경계

| 항목 | 값 |
|------|-----|
| 호출 | `aura-control-admin` HTTP만 (`AURA_CONTROL_ADMIN_URL`) |
| 테넌트 | 헤더 switcher(`display_name`) + `X-Aura-Tenant-Id` · `tenant_meta` upsert/rename · UUID paste |
| Quotas | 조회·리셋만 · `/quotas` |
| 시크릿 | `secrets_ref` 입력만 · 값 필드 없음 |
| 이미지 | `aura/admin-ui:local` · Vite `dist/` + `nginx.conf` 베이크 · dist ConfigMap 금지 |
| Scaffold | SoT=`scaffolds/` · `sync-scaffolds`→`public/scaffolds/` · Bundles **Download scaffold** |

## 표시 규칙

계약 정본: [`deploy/docs/admin-ui.md`](../../deploy/docs/admin-ui.md) 「표시 규칙」·「UX (Sprint A)」.  
요약: 첫 줄=`kind/name/version`·`display_name` · Overlay=목록+drawer · Bundle→Activate CTA · Sources 필터·타임라인 · Quotas 조회·리셋 · Audit `?action=` · `tenant_meta` · ConfirmDialog · toast/`formatApiError`.

---

## 스택

| 관심사 | 선택 |
|--------|------|
| UI | React 19 + TypeScript |
| 빌드 | Vite |
| 스타일 | Tailwind CSS v4 |
| 컴포넌트 | shadcn/ui 스타일 (Radix primitives) |
| 서버 상태 | TanStack Query v5 |
| 클라이언트 상태 | Zustand |
| 폼·검증 | React Hook Form + Zod |
| 라우팅 | React Router v7 |

---

## 디렉터리

| 경로 | 역할 |
|------|------|
| `src/main.tsx` | 진입 |
| `src/app/routes.tsx` | 라우트 |
| `src/features/*` | tenants · sources · bundles · overlays · audit |
| `src/components/ui/` | shadcn 스타일 프리미티브 |
| `src/components/confirm-dialog.tsx` | Activate/Retire/Delete confirm (+ optional reason) |
| `src/components/drawer.tsx` | Overlays New/Edit 슬라이드오버 |
| `src/components/toast-host.tsx` | 전역 toast |
| `src/lib/{api,schemas,errors}.ts` | fetch · Zod · `formatApiError` |
| `src/stores/{session,toast}.ts` | Bearer·tenant · toast 큐 |
| `ui.selftest.cjs` | 계약·금지사항 정적 게이트 (소스/디자인) |
| `public/aura-logo.jpg` | 헤더·파비콘 마크. Vite `dist/`로 복사되어 이미지에 포함 |
| `scripts/sync-scaffolds.cjs` | SoT `scaffolds/` → `public/scaffolds/` (gitignore) |
| `Dockerfile` · `nginx.conf` | repo-root build · 이미지에 굽는 정적 서버 (`listen 8080` · `/v1` → control-admin) |
| `dist/` | Vite 빌드 산출 (이미지에 포함, 클러스터 ConfigMap 아님) |

---

## Commands

```bash
bash deploy/scripts/build-admin-images.sh
bash deploy/scripts/check-admin-ui.sh
bash deploy/scripts/check-admin-ui-mvp.sh
bash deploy/scripts/apply-admin-ui.sh
cd services/admin-ui && npm run sync:scaffolds && npm test && npm run build
node services/admin-ui/ui.selftest.cjs
node services/control/admin-http.selftest.js
node services/control/pooler-lookup.selftest.js
# local UI: kubectl -n aura port-forward svc/aura-admin-ui 18080:8080
```
