# Tenant bundle scaffolds

로컬에서 agent/MCP factory를 만들고 Admin Bundles로 **소스 zip**(권장) 또는 단일 `main.js`/`main.py`를 업로드한다.  
정본 워크플로: [`deploy/docs/tenant-bundle-scaffold.md`](../deploy/docs/tenant-bundle-scaffold.md) · 멀티파일: [`tenant-bundle-multifile.md`](../deploy/docs/tenant-bundle-multifile.md).

Admin **Download scaffold (.zip)** = 폴더 전체(`main` · `lib/` · 테스트 · `package.json`/`requirements.txt`).  
업로드 시 **`node_modules` 제외** · entrypoint=`main:factory`.  
플랫폼 핀: `services/*/package.json`·`requirements.txt` · 요약 [`ALLOWED_PACKAGES.md`](ALLOWED_PACKAGES.md).

## 로컬 테스트

```bash
cd scaffolds/agent-nodejs && npm install && npm test
cd scaffolds/mcp-nodejs && npm install && npm test
# python: 각 폴더 README (.venv + pip -r requirements.txt + pytest)
node services/object-store/bundle-zip.selftest.js
```
