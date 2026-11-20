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
| 테넌트 | 배너 + `X-Aura-Tenant-Id` · 목록=`GET /v1/tenants` · UUID 직접 입력 |
| 시크릿 | `secrets_ref` 입력만 · 값 필드 없음 |
| 산출 | Vite `dist/` 정적 서빙 |

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
| `src/lib/{api,schemas}.ts` | fetch 클라이언트 · Zod |
| `src/stores/session.ts` | Bearer · tenant · baseUrl |
| `ui.selftest.cjs` | 계약·금지사항 정적 게이트 (소스/디자인) |
| `dist/` | Vite 빌드 산출 (정적 서빙) |

---

## Commands

```bash
bash deploy/scripts/check-admin-ui.sh
bash deploy/scripts/check-admin-ui-mvp.sh
cd services/admin-ui && npm test && npm run build
node services/admin-ui/ui.selftest.cjs
node services/control/admin-http.selftest.js
node services/control/pooler-lookup.selftest.js
```
