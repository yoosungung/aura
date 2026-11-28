# nats-task-bridge (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §4.1.  
런북: [`deploy/docs/nats-task-bridge.md`](../../deploy/docs/nats-task-bridge.md).  
매니페스트: [`deploy/k8s/nats-task-bridge/`](../../deploy/k8s/nats-task-bridge/).  
Rust 전환: [ROADMAP.md](../../ROADMAP.md) Phase 1 · 캔버스 `service-rust-migration`.

**이 문서 범위:** JetStream pull → `runtime`→Function → Fission Router → done/error publish.  
**Non-goals:** 도메인 handler · memory MQT 대체 · PG · subject/durable 이름 변경.

## 경계

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-task-bridge` · **ns `aura`** · **replicas≥2** · deps 포함 이미지 · `dev.orbstack.icon` |
| Subjects | `aura.tasks.agent.invoke` · `aura.tasks.mcp.invoke` |
| Durables | `aura_task_bridge_agent` · `aura_task_bridge_mcp` (Rust/Node **동일**) |
| 동시성 | 구독 루프에서 **await 금지** — 병렬 dispatch(HOL 금지) · `TASK_MAX_INFLIGHT`(기본 **32**, 권장 16–32) 세마포어 |
| Ack / lease | consumer **AckWait≥150s**(`TASK_ACK_WAIT_MS`, fetch+40s) · 실행 중 `working()` Progress heartbeat(`TASK_WORKING_INTERVAL_MS` 기본 **10s**) · `MaxDeliver=5` · ensure=`ensure-task-bridge-consumers.sh`(+기동 시 jsm ensure) |
| 스케일 | Deployment replicas≥2 · Function 쪽 KEDA lag · min=0 허용 |
| 라우팅 | `runtime`→Function. `custom`은 payload `function` 접두사 allowlist |
| 금지 | handler 로직 · 언어별 MQT 이중 구독 |

## 구현

| 경로 | 상태 |
|------|------|
| `bridge.js` (Node) | 현행 제품 이미지 기본 |
| `rs/` (Rust · `aura-nats-task-bridge`) | Phase 1 바이너리 · distroless · **동일 env**/durable |
| cutover | lab canary(동일 durable) → 이미지 교체 → Node deprecate |

## Commands

```bash
node services/nats-task-bridge/bridge.selftest.js
cargo test -p aura-nats-task-bridge
docker build -f services/nats-task-bridge/rs/Dockerfile -t aura/nats-task-bridge:local .
bash deploy/scripts/check-nats-task-bridge.sh
bash deploy/scripts/ensure-task-bridge-consumers.sh
```
