# nats-rpc-bridge (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §3.3 · §4.2.  
매니페스트: [`deploy/k8s/nats-rpc-bridge/`](../../deploy/k8s/nats-rpc-bridge/).  
Rust 전환: [ROADMAP.md](../../ROADMAP.md) Phase 1 · 캔버스 `service-rust-migration`.

**이 문서 범위:** NATS Core Request-Reply 구독 → Fission Router HTTP 중계 → `msg.respond`.  
**Non-goals:** 도메인 handler 실행 · PG · MQT · 서비스별 `*-rr` 복원 · subject/queue-group 변경.

---

## 경계

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-rpc-bridge` · **ns `aura`** · **replicas ≥ 2** |
| queue-group | `aura-rpc-bridge` (세 subject 공유) — Rust/Node **동일** (Strangler 병행 합류) |
| Router | `POST {FISSION_ROUTER_URL}/fission-function/<name>` — 기본 `http://router-internal.fission.svc:8889` (Fission 1.27 public router는 HTTPTrigger만) |
| 동시성 | 구독 루프에서 **await 금지** — 병렬 dispatch(HOL 금지) · `RPC_MAX_INFLIGHT`(기본 **64**, 권장 50–100) 세마포어 |
| fetch | 타임아웃(`RPC_FETCH_TIMEOUT_MS` 기본 **25000**, Function 30s보다 짧게) — hang 전파 차단 |
| 금지 | handler 로직 · JetStream · scale-to-zero |

## Subject → Function

| subject | runtime | Function |
|---------|---------|----------|
| `aura.rpc.memory.recall` | (무시) | `aura-memory-recall` |
| `aura.rpc.control.resolve` | (무시) | `aura-control-resolve` |
| `aura.rpc.mcp.tool` | `nodejs` (기본) | `aura-mcp-invoke-rpc` |
| `aura.rpc.mcp.tool` | `python` | `aura-mcp-invoke-rpc-py` |
| `aura.rpc.mcp.tool` | `custom` | payload `function` 접두사 `aura-mcp-invoke-rpc-` (poolmgr 슬롯 제외) |

## 구현

| 경로 | 상태 |
|------|------|
| `bridge.js` (Node) | 현행 제품 이미지 기본 |
| `rs/` (Rust · `aura-nats-rpc-bridge`) | Phase 1 바이너리 · distroless · **동일 env** (`NATS_URL`/`FISSION_ROUTER_URL`/`RPC_QUEUE`/`RPC_MAX_INFLIGHT`/`RPC_FETCH_TIMEOUT_MS`) |
| cutover | lab canary(동일 queue-group) → 이미지 교체 → Node deprecate |

### Lab canary (잔여)

1. `docker build -f services/nats-rpc-bridge/rs/Dockerfile -t aura/nats-rpc-bridge:local .`
2. Deployment에 Rust 레플리카 **1**을 Node와 **동일** `RPC_QUEUE=aura-rpc-bridge`로 병행(subject 변경 금지).
3. `check-control-resolve-bridge.sh` · recall/mcp RPC 스모크 통과 확인.
4. Node replicas → 0 · 이미지 기본을 Rust로 · 이전 태그로 롤백 가능 유지.

Deployment는 **deps 포함 이미지**만 사용한다 (initContainer `npm install` 금지). OrbStack 아이콘은 `dev.orbstack.icon`.

## Commands

```bash
node services/nats-rpc-bridge/bridge.selftest.js
cargo test -p aura-nats-rpc-bridge
docker build -f services/nats-rpc-bridge/rs/Dockerfile -t aura/nats-rpc-bridge:local .
bash deploy/scripts/build-nats-bridge-images.sh
bash deploy/scripts/check-nats-task-bridge.sh
```
