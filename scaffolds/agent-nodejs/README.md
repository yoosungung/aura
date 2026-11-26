# agent · nodejs — research agent (2 MCP tools)

이 zip만으로 로컬 테스트 → Admin 등록할 수 있다.  
기본 tools = `naver_search` + `weather`. **MCP 구현은 이 zip에 없다** — 런타임 `mcpTool` → NATS `mcp_invoke`.

## 로컬

```bash
npm install
npm test
```

업로드 zip: **`node_modules` 제외**. zip **루트**에 `main.js` · `lib/` 가 오게 묶는다. entrypoint=`main:factory`.

## 계약

| | |
|--|--|
| factory | `(cfg, secrets_ref) → { runTurn }` |
| 기본 tools | server `naver-search` / name `naver_search` · server `weather` / name `weather` |
| system | `cfg.system_prompt` (alias `systemPrompt`) |
| 로컬 테스트 | `cfg._mcp_tool` mock 또는 `runTurn({ mcpTool, input })` |

## 제약

| 주제 | 규칙 |
|------|------|
| **MCP 인라인 금지** | Naver/weather MCP 소스를 이 zip에 복사·require 하지 말 것 |
| **시크릿** | Admin/Overlay는 **`secrets_ref`만** · plaintext 금지 |
| **tools allowlist** | `cfg.tools`에 없는 name → `tool_not_allowed` |
| **PG** | 이 번들에서 `memory_*` SELECT 금지 · recall은 플랫폼 inject |
| **deps** | `node_modules` 업로드 금지 |

## Admin UI에 등록하기

전제: Admin에서 **Tenant** 선택.

라이브에서 tool이 실제로 돌아가려면 **먼저** MCP 소스 두 개가 `active`여야 한다.

| MCP source name | version | 비고 |
|-----------------|---------|------|
| `naver-search` | `1` | Bundles: kind=`mcp` · runtime=`nodejs` · 그 zip의 README대로 등록 · Overlay에 **`secrets_ref`** · egress `openapi.naver.com` |
| `weather` | `1` | Bundles: kind=`mcp` · runtime=`python` · 그 zip의 README대로 등록 · egress `api.open-meteo.com` |

(이 agent zip만 단독 등록해도 pending→active는 된다. tool 호출은 위 MCP+egress+서명 없이는 실패한다.)

### 1) zip 준비

1. Admin → **Bundles** → Kind=`agent` · Runtime=`nodejs` → **Download scaffold (.zip)** (또는 이 폴더).
2. `npm test` 통과.
3. 업로드 zip: 루트=`main.js`+`lib/` · **`node_modules` 제외**.

### 2) Bundles 폼

| 필드 | 값 |
|------|-----|
| Kind | `agent` |
| Runtime | `nodejs` |
| Name | `research-agent` |
| Version | `1-nodejs` |
| Entrypoint | `main:factory` |
| Bundle file | 위 zip |

**Config** (키·값 행):

| key | value |
|-----|--------|
| `system_prompt` | `You are a scaffold research agent. Use naver_search and weather tools.` |
| `tools` | 아래 JSON **한 줄** |

```json
[{"server":"naver-search","version":"1","name":"naver_search"},{"server":"weather","version":"1","name":"weather"}]
```

- Config에 `runtime` / `function` 키 **금지**.
- **Upload & create pending** → **Activate now**.
- 수정 시 **새 Version**으로 재등록 (`1-nodejs`와 python의 `1-python`은 UNIQUE를 피하려고 version을 가른 것).

### 3) Overlays

agent 자체 시크릿이 없으면 생략. Naver 키는 **MCP `naver-search` Overlay**에 둔다.

### 4) 라이브 호출 전

1. 위 두 MCP `active` + egress(`openapi.naver.com`, `api.open-meteo.com`).
2. agent·MCP 모두 필요 시 **플랫폼 서명(`sig_uri`)**.
3. invoke: agent=`research-agent`, version=`1-nodejs`.
