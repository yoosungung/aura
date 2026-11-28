# MESSAGE-FLOW.md

Aura **전체 시스템 메시지·호출 흐름** 다이어그램이다.  
계약·스키마·subject 표의 정본은 [ARCHITECTURE.md](ARCHITECTURE.md). 컴포넌트 내부는 각 `DESIGN.md` / `deploy/docs/*`.

**이 문서 범위:** 채널 분류 · 대화형 invoke E2E(`createAgent` 턴) · async 이원화(MQT vs task-bridge) · 메모리 파이프라인 · sync RPC.  
**Non-goals:** DDL·페이로드 필드·archive 패키징·Fair Queue 수치(→ ARCHITECTURE / `deploy/docs`).

---

## 1. 채널 삼원화 (+ 이벤트)

| 채널 | 전송 | 용도 | 스케일 |
|------|------|------|--------|
| `aura.tasks.*` | JetStream WorkQueue → **Fission MQT** (memory 등) 또는 **task-bridge** (agent/mcp) | 내구 작업 | connector/bridge `min=0` OK |
| `aura.rpc.*` | NATS **Core** Request-Reply | 동기 홉 | **공용 브리지 ≥2** + sync poolmgr Warm, MQT 금지 |
| `aura.stream.*` | NATS **Core** pub/sub | UX 토큰/툴 (유실 허용) | Gateway 구독 |
| `aura.events.*` | JetStream Limits | 완료·감사 정본 | MQT/`task-bridge` `respTopic`/`errorTopic` |
| `aura.dlq.*` | JetStream Limits | MaxDeliver 초과 격리 | Term 경로 |

```mermaid
flowchart LR
  subgraph publish["발행"]
    GW[Gateway]
    AI[agent_invoke]
    CAP[memory_capture]
    MEM[svc-memory async]
  end

  subgraph nats["NATS"]
    TASKS["AURA_TASKS<br/>aura.tasks.*"]
    EVENTS["AURA_EVENTS<br/>aura.events.*"]
    RPC["Core RR<br/>aura.rpc.*"]
    STREAM["Core pub/sub<br/>aura.stream.*"]
    DLQ["AURA_DLQ<br/>aura.dlq.*"]
  end

  GW -->|agent.invoke| TASKS
  AI -->|done/error| EVENTS
  AI -->|token/tool| STREAM
  CAP -->|capture.done| EVENTS
  MEM -->|consolidated/ttl/archive/gc| EVENTS
  AI <-->|resolve/recall/mcp| RPC
  TASKS -.->|MaxDeliver Term| DLQ
  STREAM --> GW
```

---

## 2. 토폴로지 개요

async는 **두 경로**다. memory 계열은 Fission MQT 1:1, agent/mcp는 동일 subject에 다중 `runtime`이 있어 **task-bridge**가 Function을 고른다.

```mermaid
flowchart TB
  Client((Client))

  Client -->|"POST /v1/agent/invoke"| GW[Gateway ≥2]
  Client <-->|"SSE / WS<br/>aura.stream.run_id"| GW

  GW -->|"quota OK · runtime stamp → publish"| NATS[(NATS)]

  subgraph taskBridge["async task-bridge — scale-to-zero OK"]
    TB[aura-nats-task-bridge]
    AI[agent_invoke node/py/custom]
    MCP_T[mcp_invoke task]
  end

  subgraph mqt["async Deployment — memory"]
    CAP[memory_capture inline]
    BATCH[memory-batch CronJob→tasks]
  end

  subgraph sync["sync — bridge ns aura + poolmgr Warm"]
    BR[aura-nats-rpc-bridge ≥2]
    RECALL[aura-memory-recall]
    MCP_R[aura-mcp-invoke-rpc]
    RESOLVE[aura-control-resolve]
  end

  NATS -->|"AURA_TASKS agent/mcp"| TB
  TB -->|runtime→Function| AI
  TB -->|runtime→Function| MCP_T
  NATS -->|"AURA_TASKS memory.*"| mqt
  AI -->|"aura.rpc.*"| BR
  MCP_T -->|"aura.rpc.*"| BR
  BR --> RECALL
  BR --> MCP_R
  BR --> RESOLVE
  AI -->|"aura.stream.run_id"| NATS
  NATS --> GW

  RESOLVE --> CTRL[svc-control HTTP read]
  STORE --> POOLER[CNPG Pooler]
  RECALL --> POOLER
  POOLER --> PG[(PostgreSQL)]
  AI -->|"체크포인트만"| POOLER
  AI --> LLM[LLM Gateway]
```

---

## 3. 대화형 `agent.invoke` E2E

Gateway가 쿼터·resolve(`runtime` 스탬프)를 통과한 뒤에만 JetStream에 넣고, 실행 중 UX는 Core 스트림, **완료 정본은 events**다. agent/mcp async는 **MQT가 아니라 task-bridge**다.

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant GW as Gateway
  participant KV as NATS KV quota
  participant RR0 as aura.rpc.control.resolve
  participant JS as AURA_TASKS
  participant KEDA as KEDA
  participant TB as aura-nats-task-bridge
  participant R as Fission Router
  participant AI as agent_invoke Fn
  participant RR as sync RPC Warm
  participant LLM as LLM Gateway
  participant Ev as AURA_EVENTS
  participant St as aura.stream.run_id

  Client->>GW: POST /v1/agent/invoke
  GW->>KV: tryAcquire tenant
  alt 429
    GW-->>Client: 429 quota
  else OK
    GW->>GW: run_id UUIDv7
    GW->>RR0: resolve agent source
    RR0-->>GW: runtime (+ function if custom)
    GW->>JS: aura.tasks.agent.invoke (runtime stamp)
    GW-->>Client: 202 + run_id
    Client->>GW: SSE/WS subscribe
    GW->>St: Core subscribe exact subject

    KEDA->>JS: poll consumer lag
    KEDA->>TB: scale 0→N
    TB->>JS: pull
    TB->>TB: runtime → Function name
    TB->>R: POST /fission-function/name
    R->>AI: invoke

    AI->>RR: aura.rpc.control.resolve
    RR-->>AI: cfg + secrets_ref
    AI->>St: run.started
    AI->>RR: aura.rpc.memory.recall
    RR-->>AI: items[]
    Note over AI: runTurn = createAgent (Node) / 대칭 python
    opt tools list
      AI->>RR: aura.rpc.mcp.tool action=list
      RR-->>AI: tools[]
    end
    loop model tool loop
      AI->>LLM: chat/completions via Gateway only
      LLM-->>AI: completion
      AI->>St: token
      opt tool call
        AI->>RR: aura.rpc.mcp.tool action=call
        RR-->>AI: tool result
        AI->>St: tool.started / tool.finished
      end
    end
    AI->>St: run.completed
    AI-->>TB: HTTP 2xx done body
    TB->>Ev: aura.events.agent.invoke.done
    GW->>KV: release inflight
    Note over St,Client: 스트림은 유실 허용 · 감산/감사는 events
  end
```

실패 시 Function 비-2xx → task-bridge가 `aura.events.agent.invoke.error`로 적재. poison은 MaxDeliver 후 `aura.dlq.>` Term(ARCHITECTURE §3.2).

와이어 상세: [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md) · [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) · [`deploy/docs/agent-invoke-create-agent.md`](deploy/docs/agent-invoke-create-agent.md) · [`deploy/docs/mcp-tools-list.md`](deploy/docs/mcp-tools-list.md) · [`deploy/docs/gateway-sse-ws.md`](deploy/docs/gateway-sse-ws.md) · [`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md).

---

## 4. Async 이원화: MQT vs task-bridge

### 4.1 memory 등 — Fission MQT

MQT마다 **역할이 다른 두 Deployment**가 있다. KEDA가 스케일하는 대상은 **커넥터**다. topic→Function **1:1**.

```mermaid
sequenceDiagram
  participant Pub as Publisher
  participant JS as JetStream AURA_TASKS
  participant KEDA as KEDA ScaledObject
  participant Conn as Connector Deployment
  participant Router as Fission Router
  participant Fn as Function Pod<br/>env + fetcher

  Pub->>JS: publish aura.tasks.memory.*
  KEDA->>JS: lag via monitoring :8222
  KEDA->>Conn: replicas 0…max
  Conn->>JS: pull consumer
  Conn->>Router: POST message
  Router->>Fn: specialize / invoke
  Fn-->>Conn: HTTP response
  alt 2xx
    Conn->>JS: publish respTopic → AURA_EVENTS
  else fail / retries exhausted
    Conn->>JS: publish errorTopic → AURA_EVENTS
  end
  Note over KEDA,Conn: idle → cooldown → scale to 0
  Note over Fn: poolmgr/newdeploy 별도 관리
```

| 파드 | 하는 일 | Aura async 스케일 |
|------|---------|-------------------|
| **MQT connector** | JetStream pull → Router HTTP → resp/error publish (**언어 비선택**, Fission/KEDA 이미지) | MQT `minReplicaCount=0` |
| **Function** | 핸들러 실행 (env + fetcher). memory 등은 기존 MQT 유지 | executor·env pool |

### 4.2 agent / mcp — `aura-nats-task-bridge`

동일 subject에 nodejs·python·custom을 붙이면 MQT 1:1은 경쟁 소비가 된다. **브리지가 `runtime`(및 custom `function` allowlist)만 보고 Router로 중계**한다. 도메인 handler·PG는 브리지에 두지 않는다.

```mermaid
sequenceDiagram
  participant Pub as Gateway / publisher
  participant JS as JetStream AURA_TASKS
  participant KEDA as KEDA ScaledObject
  participant TB as aura-nats-task-bridge
  participant Router as Fission Router
  participant Fn as agent/mcp Function<br/>nodejs|python|custom

  Pub->>JS: publish agent.invoke / mcp.invoke
  KEDA->>JS: lag
  KEDA->>TB: replicas 0…max
  TB->>JS: pull durable consumer
  TB->>TB: map runtime → Function
  TB->>Router: POST /fission-function/name
  Router->>Fn: invoke
  Fn-->>TB: HTTP response
  alt 2xx
    TB->>JS: respTopic → AURA_EVENTS
  else fail
    TB->>JS: errorTopic → AURA_EVENTS
  end
  Note over TB: 언어별 MQT 이중 구독 금지
```

동기 `aura.rpc.*`에는 MQT/JetStream ScaledObject를 **붙이지 않는다**(No Responders). NATS 구독은 **`aura-nats-rpc-bridge`만** — Fission Router로 Sync Function(`poolmgr`) 중계. `aura.rpc.mcp.tool`도 `runtime`→Function 매핑.

상세: [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md) · [`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md).

---

## 5. 메모리 파이프라인 (inline capture + batch CronJob)

`agent_invoke`는 `memory_*`에 직접 쓰지 않는다. 턴 종료 시 `aura.tasks.memory.capture` publish → capture 파드가 extract→embed→store 모듈을 **in-process** 실행. 배치(consolidate/ttl/archive/object_gc)는 **K8s CronJob**이 `/aura-memory-*` one-shot 실행(상시 파드 없음 · ARCHITECTURE §3.2 · §5 · [`memory-batch-cronjobs.md`](deploy/docs/memory-batch-cronjobs.md)).

```mermaid
sequenceDiagram
  participant AI as agent_invoke
  participant T as AURA_TASKS
  participant Cap as memory_capture
  participant GW as llm-gateway
  participant PG as Pooler→PG
  participant Ev as AURA_EVENTS
  participant Cron as K8s CronJob

  AI->>T: aura.tasks.memory.capture
  Note over Cap: extract → embed → storeOnce
  Cap->>GW: POST /v1/embeddings (skip short_term)
  Cap->>PG: store 모듈 withTenantTx
  Cap->>Ev: aura.events.memory.capture.done
  Note over Cron: one-shot /aura-memory-{consolidate,ttl,archive,object-gc} (UTC daily · no always-on pod)
```

대화 턴 중 **읽기**는 sync: `agent_invoke` → `aura.rpc.memory.recall` → bridge → `aura-memory-recall` → Pooler.

---

## 6. Sync RPC (bridge + poolmgr Warm)

```mermaid
sequenceDiagram
  participant AI as agent_invoke / mcp Fn
  participant NATS as NATS Core
  participant Bridge as aura_nats_rpc_bridge
  participant Router as Fission_Router
  participant Fn as Sync_Function_poolmgr
  participant Pool as CNPG Pooler
  participant Ctrl as svc-control

  AI->>NATS: request aura.rpc.*
  NATS->>Bridge: queue-group aura-rpc-bridge
  Bridge->>Router: POST /fission-function/name
  Router->>Fn: specialize_plus_invoke
  alt aura.rpc.memory.recall
    Fn->>Pool: SELECT + iterative_scan
    Pool-->>Fn: rows
  else aura.rpc.control.resolve
    Fn->>Ctrl: HTTP read meta
    Ctrl-->>Fn: cfg + secrets_ref
  else aura.rpc.mcp.tool
    Fn->>Fn: tool path / Streamable HTTP
  end
  Fn-->>Router: JSON body
  Router-->>Bridge: HTTP response
  Bridge->>NATS: msg.respond
  Note over NATS,Bridge: JetStream에 넣지 않음 · MQT로 깨우지 않음
```

---

## 7. 빠른 색인

| 보고 싶은 것 | 위치 |
|--------------|------|
| 계약·subject 표 | [ARCHITECTURE.md](ARCHITECTURE.md) §1–§4 |
| Gateway·Fair Queue | [`deploy/docs/gateway-sse-ws.md`](deploy/docs/gateway-sse-ws.md) · [`gateway-fair-queue.md`](deploy/docs/gateway-fair-queue.md) |
| agent/mcp task-bridge | [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md) · [`multi-env-followup.md`](deploy/docs/multi-env-followup.md) |
| agent_invoke 순서 | [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) |
| mcp MQT+RPC | [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) |
| control.resolve | [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md) |
| LLM egress | [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md) |
