# Admin UI (ops-only MVP · M6)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §2 · §6.1.1.  
정본: [`deploy/docs/admin-ui-mvp.md`](../../deploy/docs/admin-ui-mvp.md).  
API: [`../control/admin-http.js`](../control/admin-http.js).

**이 문서 범위:** 플랫폼 ops 정적 UI — Tenant picker · Sources · Bundle 등록 · overlays.  
**Non-goals:** 테넌트 self-serve · Chat UI · 과금 SPA · OIDC 본구현(Bearer 토큰 입력만).

---

## 경계

| 항목 | 값 |
|------|-----|
| 호출 | `aura-control-admin` HTTP만 (`AURA_CONTROL_ADMIN_URL`) |
| 테넌트 | 배너 + `X-Aura-Tenant-Id` · 목록=`GET /v1/tenants` · UUID 직접 입력 |
| 시크릿 | `secrets_ref` 입력만 · 값 필드 없음 |

---

## 파일

| 파일 | 역할 |
|------|------|
| `index.html` | 단일 페이지 셸 |
| `app.js` | API 클라이언트 · 화면 상태 |
| `ui.selftest.js` | 계약·셀렉터·금지사항 게이트 |

---

## Commands

```bash
bash deploy/scripts/check-admin-ui-mvp.sh
node services/admin-ui/ui.selftest.js
node services/control/admin-http.selftest.js
```
