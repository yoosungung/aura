# Tenant bundle scaffolds

로컬에서 agent/MCP factory를 만들고 Admin Bundles로 **단일 소스 파일**을 업로드한다.  
정본 워크플로: [`deploy/docs/tenant-bundle-scaffold.md`](../deploy/docs/tenant-bundle-scaffold.md).

플랫폼 Function archive(`deploy/scripts/build-*-archive.sh`)와 다름.

## 로컬 테스트

```bash
node scaffolds/agent-nodejs/main.selftest.js
node scaffolds/mcp-nodejs/main.selftest.js
# python: 각 폴더 README의 .venv + pytest
```

