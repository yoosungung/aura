# mcp_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #10 · #11 · #12 · §3.2 · §3.3 · §4 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) **M3.5** — `tools/list` · archive · Node RPC 워커.  
와이어: [`deploy/docs/mcp-invoke-dual.md`](../../deploy/docs/mcp-invoke-dual.md) · [`deploy/docs/mcp-tools-list.md`](../../deploy/docs/mcp-tools-list.md).  
외부 HTTP: [`deploy/docs/mcp-streamable-http.md`](../../deploy/docs/mcp-streamable-http.md).  
패키징: [`deploy/docs/fission-node-archive.md`](../../deploy/docs/fission-node-archive.md).

**이 문서 범위:** 공유 핸들러 · action=`list`\|`call` · async MQT · sync Core RR · Streamable HTTP · Node RR Deployment.  
**Non-goals:** python/rust env · full MCP initialize 서버 · CNI FQDN 라이브.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | MCP list/call: resolve → factory(`cfg`,`secrets_ref`) / Streamable HTTP |
| async | `aura.tasks.mcp.invoke` → `aura.events.mcp.invoke.done` / `aura.events.mcp.invoke.error` · consumer `aura_mcp_invoke` · **minReplicaCount=0** (scale-to-zero) |
| sync | `aura.rpc.mcp.tool` · Warm **MinScale≥2** · Deployment `aura-mcp-invoke-rr` replicas≥2 |
| 실행 계급 | **이원화** — MQT `min=0` **와** Warm RPC `MinScale≥2` **별 매니페스트** |
| 패키징 | **archive** + `node-builder` |
| PG | **금지** |
| RPC 워커 | Deployment `aura-mcp-invoke-rr` = **Node** NATS queue-group (nats-box stub 폐기) |

---

## 모듈

| 파일 | 역할 |
|------|------|
| `handler.js` | validate · invoke list/call · task/rpc entry |
| `streamable-http.js` | `tools/list` + `tools/call` JSON-RPC/SSE |
| `factory.js` | resolve cfg → runTool / listTools |
| `rpc-worker.js` | Core RR 구독 엔트리 (Deployment) |

---

## Commands

```bash
bash deploy/scripts/check-mcp-invoke-dual.sh
bash deploy/scripts/check-mcp-streamable-http.sh
bash deploy/scripts/check-mcp-bundle-isolation.sh
bash deploy/scripts/check-high-risk-tenant-nodepool.sh
bash deploy/scripts/build-mcp-invoke-archive.sh
node services/mcp-invoke/handler.selftest.js
node services/mcp-invoke/streamable-http.selftest.js
```

격리·Egress: [`deploy/docs/mcp-bundle-isolation.md`](../../deploy/docs/mcp-bundle-isolation.md) · [`deploy/docs/egress-block-verify.md`](../../deploy/docs/egress-block-verify.md) · `check-egress-block-verify.sh`.  
고위험 전용 RuntimeClass/노드풀: [`deploy/docs/high-risk-tenant-nodepool.md`](../../deploy/docs/high-risk-tenant-nodepool.md).
