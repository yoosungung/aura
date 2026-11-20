# nats-task-bridge (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §4.1.  
런북: [`deploy/docs/nats-task-bridge.md`](../../deploy/docs/nats-task-bridge.md).  
매니페스트: [`deploy/k8s/nats-task-bridge/`](../../deploy/k8s/nats-task-bridge/).

**이 문서 범위:** JetStream pull → `runtime`→Function → Fission Router → done/error publish.  
**Non-goals:** 도메인 handler · memory MQT 대체 · PG.

## 경계

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-task-bridge` · **ns `aura`** · deps 포함 이미지 · `dev.orbstack.icon` |
| Subjects | `aura.tasks.agent.invoke` · `aura.tasks.mcp.invoke` |
| 스케일 | KEDA lag · min=0 허용 |
| 라우팅 | `runtime`→Function. `custom`은 payload `function` 접두사 allowlist |
| 금지 | handler 로직 · 언어별 MQT 이중 구독 |

## Commands

```bash
node services/nats-task-bridge/bridge.selftest.js
bash deploy/scripts/check-nats-task-bridge.sh
```
