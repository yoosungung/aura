# NATS task-bridge — agent/mcp async multi-runtime (M3.6)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §4.1.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.6.  
multi-env: [`multi-env-followup.md`](multi-env-followup.md).  
코드: [`../../services/nats-task-bridge/`](../../services/nats-task-bridge/).  
매니페스트: [`../k8s/nats-task-bridge/`](../k8s/nats-task-bridge/).

**이 문서 범위:** JetStream pull → `runtime`→Function → Fission Router · resp/error publish · KEDA lag.  
**Non-goals:** 도메인 handler · memory tasks MQT 대체 · container 이미지 빌드.

---

## 왜 MQT가 아닌가

Fission MQT는 topic→Function **1:1**. 동일 `aura.tasks.agent.invoke`에 nodejs·python Function을 동시에 붙이면 경쟁 소비가 된다. sync RPC와 같이 **브리지가 Function만 고른다**.

## 계약

| 항목 | 값 |
|------|-----|
| Deployment | `aura-nats-task-bridge` · **ns `aura`** · deps 포함 이미지 (initContainer `npm install` 금지) |
| Subjects | `aura.tasks.agent.invoke` · `aura.tasks.mcp.invoke` |
| Consumer | pull · stream `AURA_TASKS` · durable 이름 고정(`aura_task_bridge_agent` / `aura_task_bridge_mcp`) |
| 라우팅 | payload `runtime` (없으면 `nodejs`) → Function 표. `custom`은 payload `function` 접두사 allowlist ([`multi-env-followup.md`](multi-env-followup.md)) |
| 호출 | `POST {FISSION_ROUTER_URL}/fission-function/<name>` |
| 응답 | Function 2xx body → `respTopic`; 비-2xx/예외 → `errorTopic` (기존 MQT envelope와 동형) |
| 스케일 | KEDA JetStream lag · **min=0 허용** |
| 금지 | 브리지 내 agent/mcp 도메인 로직 · PG · 언어별 이중 MQT |

| subject | respTopic | errorTopic |
|---------|-----------|------------|
| `aura.tasks.agent.invoke` | `aura.events.agent.invoke.done` | `aura.events.agent.invoke.error` |
| `aura.tasks.mcp.invoke` | `aura.events.mcp.invoke.done` | `aura.events.mcp.invoke.error` |

## 게이트

```bash
bash deploy/scripts/check-nats-task-bridge.sh
node services/nats-task-bridge/bridge.selftest.js
```
