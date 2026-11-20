# mcp_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #10 · #11 · #12 · §3.2 · §3.3 · §4 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) **M3.5–M3.6**.  
와이어: [`deploy/docs/mcp-invoke-dual.md`](../../deploy/docs/mcp-invoke-dual.md) · [`deploy/docs/multi-env-followup.md`](../../deploy/docs/multi-env-followup.md).  
패키징: [`deploy/docs/fission-node-archive.md`](../../deploy/docs/fission-node-archive.md) · [`deploy/docs/fission-python-archive.md`](../../deploy/docs/fission-python-archive.md).

**이 문서 범위:** `nodejs/`/`python/` · action=`list`\|`call` · task-bridge async · rpc-bridge sync · runtime 매핑.  
**Non-goals:** custom-env · full MCP initialize 서버 · CNI FQDN 라이브.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | MCP list/call: resolve → factory / Streamable HTTP |
| async | `aura.tasks.mcp.invoke` → `aura.events.mcp.invoke.done` / `aura.events.mcp.invoke.error` · **task-bridge** (MQT 폐기) |
| sync | `aura.rpc.mcp.tool` · **nats-rpc-bridge** → runtime→`aura-mcp-invoke-rpc` \| `-py` · **poolmgr** Warm (`aura-*-sync` poolsize ≥ 2) |
| Functions | nodejs: `aura-mcp-invoke` / `aura-mcp-invoke-rpc` · python: `*-py` |
| 패키징 | archive · `nodejs/` + `python/` |
| PG | **금지** |

---

## 레이아웃

| 경로 | 역할 |
|------|------|
| `DESIGN.md` | 공통 계약 |
| `nodejs/` | handler · streamable-http · factory |
| `python/` | 패리티 handler · pytest |
| `testdata/` | 공유 JSON |

Streamable HTTP: [`deploy/docs/mcp-streamable-http.md`](../../deploy/docs/mcp-streamable-http.md) · `nodejs/streamable-http.js`.

---

## Commands

```bash
bash deploy/scripts/check-mcp-invoke-dual.sh
bash deploy/scripts/check-mcp-streamable-http.sh
bash deploy/scripts/check-python-env-parity.sh
bash deploy/scripts/build-mcp-invoke-archive.sh
bash deploy/scripts/build-mcp-invoke-python-archive.sh
node services/mcp-invoke/nodejs/handler.selftest.js
node services/mcp-invoke/nodejs/streamable-http.selftest.js
```
