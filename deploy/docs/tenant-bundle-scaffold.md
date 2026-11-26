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

| 경로 | kind | runtime | entrypoint | 샘플 |
|------|------|---------|------------|------|
| `scaffolds/agent-nodejs/` | agent | nodejs | `main:factory` | **동일 research agent** · tools=`naver_search`+`weather` |
| `scaffolds/agent-python/` | agent | python | `main:factory` | **동일 research agent** · tools=`naver_search`+`weather` |
| `scaffolds/mcp-nodejs/` | mcp | nodejs | `main:factory` | **Naver Search** (`naver_search`, 시크릿) |
| `scaffolds/mcp-python/` | mcp | python | `main:factory` | **Open-Meteo** (`weather`, 키 없음) |

### Agent 샘플 (nodejs ≡ python)

두 런타임 agent는 **같은 `cfg.tools` / system prompt** 다. MCP 바이트는 agent zip에 넣지 않는다 — `runTurn`이 `mcpTool`(플랫폼) 또는 로컬 `_mcp_tool` mock으로 `naver-search`·`weather` 서버를 호출한다.

### MCP 샘플 (이원화)

echo만으로는 tool schema·외부 HTTPS·에러 경로를 배우기 어렵다. **두 슬롯이 다른 축**을 보여 준다.

| | mcp-nodejs | mcp-python |
|--|------------|------------|
| tool | `naver_search` | `weather` |
| API | `openapi.naver.com` Search | `api.open-meteo.com` forecast |
| 시크릿 | `{ client_id, client_secret }` / `NAVER_*` env · Admin은 **`secrets_ref`만** | 없음 (`secrets` 자리만) |
| HTTP 클라이언트 | `fetch` | **stdlib `urllib`** (`httpx` **미도입** — 공유 Function 핀 확대 보류) |
| Egress 등록 | `openapi.naver.com` | `api.open-meteo.com` |
| 오프라인 테스트 | mock `fetchImpl` | mock `fetch_impl` |

공통 제약: Egress deny-default · gVisor · zip에 deps 금지 · **`mcp_invoke` PG 금지** · [`mcp-bundle-isolation.md`](mcp-bundle-isolation.md) · [`egress-block-verify.md`](egress-block-verify.md).  
온디맨드 메모리 드릴은 scaffold 범위 밖(ARCHITECTURE §6.3 · ROADMAP 미결정).

---

## Admin UI 등록

**슬롯별 따라 하기 SoT = 각 `scaffolds/*/README.md`** (Download zip 안에 README 포함).  
이 절은 인덱스만 — 절차·폼 값·Overlay·Egress는 README에 중복하지 않고 README를 연다.

| 슬롯 | README |
|------|--------|
| mcp-nodejs | [`scaffolds/mcp-nodejs/README.md`](../../scaffolds/mcp-nodejs/README.md) |
| mcp-python | [`scaffolds/mcp-python/README.md`](../../scaffolds/mcp-python/README.md) |
| agent-nodejs | [`scaffolds/agent-nodejs/README.md`](../../scaffolds/agent-nodejs/README.md) |
| agent-python | [`scaffolds/agent-python/README.md`](../../scaffolds/agent-python/README.md) |

권장 등록 순서(라이브 tool 경로): `naver-search`(+Overlay) → `weather` → `research-agent` (nodejs/python).

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
