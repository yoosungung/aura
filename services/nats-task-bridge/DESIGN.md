# nats-task-bridge (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §4.1.  
런북: [`deploy/docs/nats-task-bridge.md`](../../deploy/docs/nats-task-bridge.md).  
매니페스트: [`deploy/k8s/nats-task-bridge/`](../../deploy/k8s/nats-task-bridge/).

**이 문서 범위:** JetStream pull → `runtime`→Function → Fission Router → done/error publish.  
**Non-goals:** 도메인 handler · memory MQT 대체 · PG.

## 경계

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-task-bridge` · **ns `aura`** · **replicas≥2** · deps 포함 이미지 · `dev.orbstack.icon` |
| Subjects | `aura.tasks.agent.invoke` · `aura.tasks.mcp.invoke` |
| 동시성 | `for await`에서 **await 금지** — `void dispatchTaskMessage` 병렬(HOL 금지) · `TASK_MAX_INFLIGHT`(기본 **32**, 권장 16–32) 세마포어 |
| Ack / lease | consumer **AckWait≥150s**(`TASK_ACK_WAIT_MS`, fetch+40s) · 실행 중 `msg.working()` heartbeat(`TASK_WORKING_INTERVAL_MS` 기본 **10s**) · `MaxDeliver=5` · ensure=`ensure-task-bridge-consumers.sh`(+기동 시 jsm ensure) |
| 스케일 | Deployment replicas≥2 · Function 쪽 KEDA lag · min=0 허용 |
| 라우팅 | `runtime`→Function. `custom`은 payload `function` 접두사 allowlist |
| 금지 | handler 로직 · 언어별 MQT 이중 구독 |

## Commands

```bash
node services/nats-task-bridge/bridge.selftest.js
bash deploy/scripts/check-nats-task-bridge.sh
bash deploy/scripts/ensure-task-bridge-consumers.sh
```
