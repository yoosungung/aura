# Tenant bundle — allowed packages

계약: [ARCHITECTURE.md](../ARCHITECTURE.md) §1 #11 · 워크플로: [`deploy/docs/tenant-bundle-scaffold.md`](../deploy/docs/tenant-bundle-scaffold.md).

**규칙:** 테넌트 번들은 **공유 Function 파드** 안에서 로드된다.  
Admin에 **업로드하는 것은 소스 파일(`main.js`/`main.py`)만** — `node_modules` / site-packages 업로드 금지.

**로컬 개발:** Admin **Download scaffold (.zip)** 에 아래 deps 파일이 **폴더 안에 포함**된다. 테넌트는 압축 해제 후 폴더 안 설치·테스트.  
**모노레포 기여자:** 루트 `npm install`(workspaces) + 루트 `.venv`/`requirements.txt` — 서비스 핀 SoT·scaffold 미러 파일은 그대로 둔다.

| slot | zip 안 deps | 플랫폼 핀(버전 정본) |
|------|-------------|----------------------|
| `agent-nodejs` | `package.json` | [`services/agent-invoke/nodejs/package.json`](../services/agent-invoke/nodejs/package.json) |
| `agent-python` | `requirements.txt` | [`services/agent-invoke/python/requirements.txt`](../services/agent-invoke/python/requirements.txt) |
| `mcp-nodejs` | `package.json` | [`services/mcp-invoke/nodejs/package.json`](../services/mcp-invoke/nodejs/package.json) |
| `mcp-python` | `requirements.txt` | [`services/mcp-invoke/python/requirements.txt`](../services/mcp-invoke/python/requirements.txt) |

scaffold 쪽 `package.json` / `requirements.txt` 는 위 핀의 **미러**(로컬 `npm i` / `pip install -r` 용). 버전을 바꿀 때는 **플랫폼 핀을 먼저** 고치고 scaffold 미러를 맞춘다.

## 요약 (현재 미러)

### agent · nodejs
`langchain` · `@langchain/core` · `nats` · `pg` · `zod`

### mcp · nodejs
`nats`

### agent · python
`fastapi` · `langchain` · `langchain-core` · `nats-py` · `psycopg[binary]` (+ 로컬 `pytest`)

### mcp · python
`fastapi` · `nats-py` (+ 로컬 `pytest`) · PG 금지(Node `mcp`와 동일)

**보류:** `httpx` — scaffold `weather`는 stdlib `urllib`로 충분. 공유 Function archive 전부에 들어가므로 필요해질 때만 **플랫폼 `services/mcp-invoke/python/requirements.txt`를 먼저** 핀한 뒤 미러.

## custom
이미지 자체 deps — 이 zip/allowlist **비적용**.
