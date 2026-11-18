# mcp_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #10 · #11 · #12 · §3.2 · §3.3 · §4 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — `mcp_invoke` **이원화**.  
와이어 정본: [`deploy/docs/mcp-invoke-dual.md`](../../deploy/docs/mcp-invoke-dual.md).  
외부 HTTP: [`deploy/docs/mcp-streamable-http.md`](../../deploy/docs/mcp-streamable-http.md).  
격리 정책: [`deploy/docs/mcp-bundle-isolation.md`](../../deploy/docs/mcp-bundle-isolation.md) (RuntimeClass·Egress allowlist·서명 차등). Egress 검증: [`deploy/docs/egress-block-verify.md`](../../deploy/docs/egress-block-verify.md) · [`egress-allowlist.js`](egress-allowlist.js).  
resolve: [`deploy/docs/svc-control-resolve.md`](../../deploy/docs/svc-control-resolve.md).  
요청자: [`../agent-invoke/DESIGN.md`](../agent-invoke/DESIGN.md) (`aura.rpc.mcp.tool`).

**이 문서 범위:** 공유 툴 핸들러 · **async MQT**(`aura.tasks.mcp.invoke`) · **sync Core RR**(`aura.rpc.mcp.tool`, minReplicas ≥ 2) · 분리 배포.  
**Non-goals (본 슬라이스):** live NATS Core 클라이언트 배선 · live LLM · F1 샤딩 · full MCP initialize/세션 서버 · legacy HTTP+SSE transport · CNI FQDN 라이브 프로브. (`aura.rpc.control.resolve` 브리지: [`../control/DESIGN.md`](../control/DESIGN.md))

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | MCP 툴 실행: resolve → stub factory(`cfg`,`secrets_ref`); task done / rpc reply |
| 실행 계급 | **이원화** — async MQT(`minReplicaCount=0`) **와** sync Warm(`minReplicas ≥ 2`) **별 매니페스트** |
| PG | **금지** (Zero Direct Write). Pooler/DSN/`set_config` 미사용 |
| 프로토콜 | Aura 내부 = NATS만 (§1 #12). 외부 MCP = Streamable HTTP 클라이언트 ([`streamable-http.js`](streamable-http.js)) |
| 금지 | `memory_*` 쓰기 · plaintext `secrets` · invoke payload에 bundle/cfg · **동일 Deployment에 0과 ≥2 혼합** |

---

## Async MQT (§3.2 · §4.1)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.mcp.invoke` |
| consumer | `aura_mcp_invoke` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.mcp.invoke.done` |
| errorTopic | `aura.events.mcp.invoke.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| scale | `minReplicaCount=0` (scale-to-zero) |
| 매니페스트 | [`deploy/k8s/mcp-invoke/`](../../deploy/k8s/mcp-invoke/) |

성공 HTTP 200 본문 = `type: mcp.invoke.done` → MQT `respTopic`.

---

## Sync RPC (§3.3 · §4.2)

| 필드 | 값 |
|------|-----|
| subject | `aura.rpc.mcp.tool` |
| queue-group | `aura-mcp-invoke` |
| 응답자 | Deployment `aura-mcp-invoke-rr` · **replicas ≥ 2** |
| Warm Function | `aura-mcp-invoke-rpc` · `newdeploy` · **MinScale ≥ 2** |
| 트리거 | 기동 시 NATS Core `nats reply -q` — **MQT 없음** · **JetStream lag ScaledObject 없음** |
| 매니페스트 | [`deploy/k8s/mcp-invoke-rpc/`](../../deploy/k8s/mcp-invoke-rpc/) |

성공 본문 `type: mcp.tool.done` · `ok` · `result`. 실패 `type: mcp.tool.error`.

---

## 공유 실행

`handler.js`: `validateMcpRequest` → injectable `resolve`(kind=`mcp`) → `runTool`(injectable; 없으면 cfg `streamable_http`/`mcp_endpoint` → [`streamable-http.js`](streamable-http.js), 아니면 stub).  
payload = §7 식별자만 (`server`/`version`/`tool`/`arguments`/`principal`).  
plaintext `secrets` from resolve → 거부.

---

## Commands

```bash
bash deploy/scripts/check-mcp-invoke-dual.sh
bash deploy/scripts/check-mcp-streamable-http.sh
bash deploy/scripts/check-mcp-bundle-isolation.sh
bash deploy/scripts/check-egress-block-verify.sh
node services/mcp-invoke/handler.selftest.js
node services/mcp-invoke/streamable-http.selftest.js
node services/mcp-invoke/egress-allowlist.selftest.js
```
