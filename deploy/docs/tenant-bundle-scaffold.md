# Tenant bundle scaffold (nodejs / python)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #11 · Admin: [`admin-ui.md`](admin-ui.md).  
로더: agent [`services/agent-invoke/nodejs/bundle-turn.js`](../../services/agent-invoke/nodejs/bundle-turn.js) · mcp [`services/mcp-invoke/nodejs/bundle-factory.js`](../../services/mcp-invoke/nodejs/bundle-factory.js).

**이 문서 범위:** 테넌트 agent/MCP **소스 번들** 로컬 개발 → 업로드 → (보조) 다운로드.  
**Non-goals:** 플랫폼 Function archive(`build-*-archive.sh`) · multi-file zip 해제 · custom image · OIDC.

---

## 주 경로 (만들 것)

1. Admin → Bundles **Download scaffold**(kind×runtime) 또는 저장소 [`scaffolds/`](../../scaffolds/) 복사. SoT=`scaffolds/` · UI는 빌드 시 정적 미러.
2. 로컬에서 `factory(cfg, secrets_ref)` 를 구현하고 **아래 Commands로 단위 테스트**한다 (Garage/NATS 불필요).
3. **모듈 소스 파일 하나**를 Admin → Bundles 에 업로드한다 (확장자 `.js` / `.py` 권장).
4. Entrypoint = `module:attr` (샘플은 `main:factory`).
5. Activate (서버 sha256 대조).

현재 런타임 로더는 Garage 객체 바이트를 **단일 모듈 소스**로 `eval`/`exec` 한다. multi-file `.zip` 해제는 **미지원** — zip을 올리면 activate는 되어도 invoke 시 factory 로드가 실패한다.

플랫폼 `aura-agent-invoke` / `aura-mcp-invoke` archive 와 **혼동 금지**.

## 보조 경로 (받을 것)

이미 등록된 zip/소스 버전을 패치할 때:

1. Sources 행 **Download** → `GET /v1/sources/{id}/bundle`
2. 로컬 수정 → **새 version** 으로 다시 업로드 (콘텐츠 불변 · in-place 수정 금지)
3. custom(`runtime=custom`) 은 다운로드 대상 아님 (`bundle_not_downloadable`)

## scaffold 목록

| 경로 | kind | runtime | entrypoint |
|------|------|---------|------------|
| `scaffolds/agent-nodejs/main.js` | agent | nodejs | `main:factory` |
| `scaffolds/agent-python/main.py` | agent | python | `main:factory` |
| `scaffolds/mcp-nodejs/main.js` | mcp | nodejs | `main:factory` |
| `scaffolds/mcp-python/main.py` | mcp | python | `main:factory` |

각 폴더 `README.md` 에 업로드 한 줄 요약.

## Commands (로컬 factory)

```bash
node scaffolds/agent-nodejs/main.selftest.js
node scaffolds/mcp-nodejs/main.selftest.js

python3 -m venv scaffolds/agent-python/.venv
scaffolds/agent-python/.venv/bin/pip install pytest
scaffolds/agent-python/.venv/bin/python -m pytest -q scaffolds/agent-python

python3 -m venv scaffolds/mcp-python/.venv
scaffolds/mcp-python/.venv/bin/pip install pytest
scaffolds/mcp-python/.venv/bin/python -m pytest -q scaffolds/mcp-python
```

Admin UI 정적 미러(개발·이미지):

```bash
cd services/admin-ui && npm run sync:scaffolds
# Docker: build context = repo root (services/admin-ui/Dockerfile)
```

플랫폼/Admin 회귀:

```bash
node services/control/admin-http.selftest.js
node services/admin-ui/ui.selftest.cjs
```

