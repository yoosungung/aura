# nats-rpc-bridge (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §3.3 · §4.2.  
매니페스트: [`deploy/k8s/nats-rpc-bridge/`](../../deploy/k8s/nats-rpc-bridge/).  
하드코드: [`deploy/docs/memory-control-hardcode.md`](../../deploy/docs/memory-control-hardcode.md).  
Rust 전환: [ROADMAP.md](../../ROADMAP.md) Phase 1 · [`deploy/docs/service-rust-strangler-lab.md`](../../deploy/docs/service-rust-strangler-lab.md).

**이 문서 범위:** NATS Core Request-Reply 구독 → HTTP 중계 → `msg.respond` (handler 금지).  
**Non-goals:** 도메인 handler 실행 · PG · MQT · 서비스별 `*-rr` 복원 · subject/queue-group 변경.

---

## 경계

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-rpc-bridge` · **ns `aura`** · **replicas ≥ 2** |
| queue-group | `aura-rpc-bridge` (세 subject 공유) |
| Router / targets | **mcp.tool** → `POST {FISSION_ROUTER_URL}/fission-function/<name>` (기본 `:8889`). **recall/resolve** → Service HTTP `http://aura-memory-recall.aura.svc:8080/` · `http://aura-control-resolve.aura.svc:8080/` (`serviceUrlForSubject` / `service_url_for_subject` · env override) |
| 동시성 | 구독 루프에서 **await 금지** — 병렬 dispatch(HOL 금지) · `RPC_MAX_INFLIGHT`(기본 **64**) |
| fetch | 타임아웃(`RPC_FETCH_TIMEOUT_MS` 기본 **25000**) |
| 금지 | handler 로직 · JetStream · scale-to-zero |

## Subject → Target

| subject | runtime | Target |
|---------|---------|--------|
| `aura.rpc.memory.recall` | (무시) | Deployment Service `aura-memory-recall` |
| `aura.rpc.control.resolve` | (무시) | Deployment Service `aura-control-resolve` |
| `aura.rpc.mcp.tool` | `nodejs` (기본) | Fission `aura-mcp-invoke-rpc` |
| `aura.rpc.mcp.tool` | `python` | Fission `aura-mcp-invoke-rpc-py` |
| `aura.rpc.mcp.tool` | `custom` | payload `function` 접두사 `aura-mcp-invoke-rpc-` (poolmgr 슬롯 제외) |

## 구현

| 경로 | 상태 |
|------|------|
| `rs/` (Rust · `aura-nats-rpc-bridge`) | **제품 이미지 기본** · distroless · Service URL 라우팅 포함 |
| `bridge.js` | 패리티/selftest · 동일 subject→Service/Fission 맵 |

Deployment는 **deps 포함 이미지**만 사용한다. OrbStack 아이콘은 `dev.orbstack.icon`.

## Commands

```bash
node services/nats-rpc-bridge/bridge.selftest.js
cargo test -p aura-nats-rpc-bridge
docker build -f services/nats-rpc-bridge/Dockerfile -t aura/nats-rpc-bridge:local .
bash deploy/scripts/build-nats-bridge-images.sh
bash deploy/scripts/check-memory-control-hardcode.sh
```
