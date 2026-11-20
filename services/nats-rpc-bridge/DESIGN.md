# nats-rpc-bridge (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §3.3 · §4.2.  
매니페스트: [`deploy/k8s/nats-rpc-bridge/`](../../deploy/k8s/nats-rpc-bridge/).

**이 문서 범위:** NATS Core Request-Reply 구독 → Fission Router HTTP 중계 → `msg.respond`.  
**Non-goals:** 도메인 handler 실행 · PG · MQT · 서비스별 `*-rr` 복원.

---

## 경계

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-rpc-bridge` · **replicas ≥ 2** |
| queue-group | `aura-rpc-bridge` (세 subject 공유) |
| Router | `POST {FISSION_ROUTER_URL}/fission-function/<name>` — 기본 `http://router-internal.fission.svc:8889` (Fission 1.27 public router는 HTTPTrigger만) |
| 동시성 | 구독 루프는 `dispatchNatsMessage` 병렬(HOL 금지) · `RPC_MAX_INFLIGHT`(기본 32) 세마포어 |
| fetch | `AbortController` + timeout · `RPC_FETCH_TIMEOUT_MS`(기본 25000, Function timeout 30s보다 짧게) |
| 금지 | handler 로직 · JetStream · scale-to-zero |

## Subject → Function

| subject | Function |
|---------|----------|
| `aura.rpc.memory.recall` | `aura-memory-recall` |
| `aura.rpc.control.resolve` | `aura-control-resolve` |
| `aura.rpc.mcp.tool` | `aura-mcp-invoke-rpc` |

## Commands

```bash
node services/nats-rpc-bridge/bridge.selftest.js
```
