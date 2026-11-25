# Tenant bundle scaffold (nodejs / python)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #11 · §7 · Admin: [`admin-ui.md`](admin-ui.md).  
멀티파일: [`tenant-bundle-multifile.md`](tenant-bundle-multifile.md).  
로더: [`services/object-store/bundle-zip.js`](../../services/object-store/bundle-zip.js).

**이 문서 범위:** 테넌트 agent/MCP **소스 번들** 로컬 개발 → zip 업로드 → (보조) 다운로드.  
**허용 패키지:** [`scaffolds/ALLOWED_PACKAGES.md`](../../scaffolds/ALLOWED_PACKAGES.md) (핀 SoT=`services/*/package.json`·`requirements.txt`).  
**Non-goals:** 테넌트 zip 안 `npm install` 결과를 Garage에 올리기 · custom image · OIDC.

---

## 주 경로 (만들 것)

1. Admin → Bundles **Download scaffold (.zip)** — 폴더 전체(`main` · `lib/` · 테스트 · **`package.json`/`requirements.txt`**).
2. 압축 해제 후 `npm install` / `pip install -r requirements.txt` (로컬만).
3. 소스 추가·수정 · 상대 `require`/`import` · scaffold 테스트.
4. **`node_modules` 제외**하고 소스 트리를 zip으로 Bundles 업로드 (또는 scaffold zip을 수정 후 재압축). Entrypoint=`main:factory`.
5. Activate (객체 전체 sha256).

단일 `.js`/`.py` 업로드는 **하위호환**. 제품 권장은 **멀티파일 zip**.

플랫폼 Function archive(`build-*-archive.sh`)와 **혼동 금지**.

## 보조 경로 (받을 것)

1. Sources **Download** → 등록된 객체(보통 zip)  
2. 수정 → **새 version** 업로드  
3. custom → 다운로드 대상 아님

## scaffold 목록

| 경로 | kind | runtime | entrypoint |
|------|------|---------|------------|
| `scaffolds/agent-nodejs/` | agent | nodejs | `main:factory` |
| `scaffolds/agent-python/` | agent | python | `main:factory` |
| `scaffolds/mcp-nodejs/` | mcp | nodejs | `main:factory` |
| `scaffolds/mcp-python/` | mcp | python | `main:factory` |

## Commands (로컬 factory)

```bash
cd scaffolds/agent-nodejs && npm install && npm test
cd scaffolds/mcp-nodejs && npm install && npm test

python3 -m venv scaffolds/agent-python/.venv
scaffolds/agent-python/.venv/bin/pip install -r scaffolds/agent-python/requirements.txt
scaffolds/agent-python/.venv/bin/python -m pytest -q scaffolds/agent-python

node services/object-store/bundle-zip.selftest.js
```

Admin UI 정적 미러:

```bash
cd services/admin-ui && npm run sync:scaffolds
```
