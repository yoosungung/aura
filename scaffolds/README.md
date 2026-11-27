# Tenant bundle scaffolds

로컬에서 agent/MCP factory를 만들고 Admin Bundles로 **소스 zip**(권장)을 업로드한다.

**따라 하기:** 각 슬롯 폴더의 **`README.md`만** 보면 로컬 테스트·Admin 등록·제약이 끝난다 (다른 문서로 보내지 않음).

| 슬롯 | README |
|------|--------|
| mcp-nodejs | [`mcp-nodejs/README.md`](mcp-nodejs/README.md) — Naver Search |
| mcp-python | [`mcp-python/README.md`](mcp-python/README.md) — Open-Meteo weather |
| agent-nodejs | [`agent-nodejs/README.md`](agent-nodejs/README.md) — research agent + 2 tools |
| agent-python | [`agent-python/README.md`](agent-python/README.md) — 위와 동일 스펙 |

Admin **Download scaffold (.zip)** = 해당 폴더 전체. 업로드 시 **`node_modules`/`.venv` 제외** · entrypoint=`main:factory`.  
플랫폼 핀 요약: [`ALLOWED_PACKAGES.md`](ALLOWED_PACKAGES.md).

## 로컬 테스트

**모노레포 기여자:** 루트에서 `npm install` + `.venv`(공유).  
**테넌트 zip 단독:** 압축 해제 폴더 안 `npm install` / `.venv` + `pip -r requirements.txt` (미러 파일 유지).

```bash
# from repo root (after npm install + .venv)
npm test -w aura-scaffold-agent-nodejs
npm test -w aura-scaffold-mcp-nodejs
.venv/bin/python -m pytest -q scaffolds/agent-python scaffolds/mcp-python
node services/object-store/bundle-zip.selftest.js
```
