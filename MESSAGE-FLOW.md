# MESSAGE-FLOW.md

Aura **전체 시스템 메시지·호출 흐름** 다이어그램이다.  
계약·스키마·subject 표의 정본은 [ARCHITECTURE.md](ARCHITECTURE.md). 컴포넌트 내부는 각 `DESIGN.md` / `deploy/docs/*`.

**이 문서 범위:** 채널 분류 · 대화형 invoke E2E(`createAgent` 턴) · MQT 파드 관계 · 메모리 파이프라인 · sync RPC.  
**Non-goals:** DDL·페이로드 필드·archive 패키징·Fair Queue 수치(→ ARCHITECTURE / `deploy/docs`).

---

## 1. 채널 삼원화 (+ 이벤트)

| 채널 | 전송 | 용도 | 스케일 |
|------|------|------|--------|
| `aura.tasks.*` | JetStream WorkQueue → **Fission MQT** | 내구 작업 | connector `min=0` OK |
| `aura.rpc.*` | NATS **Core** Request-Reply | 동기 홉 | **공용 브리지 ≥2** + sync poolmgr Warm, MQT 금지 |
| `aura.stream.*` | NATS **Core** pub/sub | UX 토큰/툴 (유실 허용) | Gateway 구독 |
| `aura.events.*` | JetStream Limits | 완료·감사 정본 | MQT `respTopic`/`errorTopic` 등 |
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
  CAP -->|candidates| EVENTS
  MEM -->|stored/embedded| EVENTS
  AI <-->|resolve/recall/mcp| RPC
  TASKS -.->|MaxDeliver Term| DLQ
  STREAM --> GW
```

---

## 2. 토폴로지 개요

```mermaid
flowchart TB
  Client((Client))

  Client -->|"POST /v1/agent/invoke"| GW[Gateway ≥2]
  Client <-->|"SSE / WS<br/>aura.stream.run_id"| GW

  GW -->|"quota OK → publish"| NATS[(NATS)]

  subgraph async["async MQT — scale-to-zero OK"]
    AI[agent_invoke]
    MCP_T[mcp_invoke task]
    CAP[memory_capture]
    STORE[svc-memory store/embed/…]
  end

  subgraph sync["sync — bridge ns aura + poolmgr Warm"]
    BR[aura-nats-rpc-bridge ≥2]
    RECALL[aura-memory-recall]
    MCP_R[aura-mcp-invoke-rpc]
    RESOLVE[aura-control-resolve]
  end

  NATS -->|"AURA_TASKS"| async
  async -->|"aura.rpc.*"| BR
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

Gateway가 쿼터를 통과한 뒤에만 JetStream에 넣고, 실행 중 UX는 Core 스트림, **완료 정본은 events**다.

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant GW as Gateway
  participant KV as NATS KV quota
  participant JS as AURA_TASKS
  participant KEDA as KEDA
  participant Conn as MQT connector
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
    GW->>JS: aura.tasks.agent.invoke
    GW-->>Client: 202 + run_id
    Client->>GW: SSE/WS subscribe
    GW->>St: Core subscribe exact subject

    KEDA->>JS: poll consumer lag
    KEDA->>Conn: scale 0→N
    Conn->>JS: pull
    Conn->>R: HTTP POST body
    R->>AI: invoke

    AI->>RR: aura.rpc.control.resolve
    RR-->>AI: cfg + secrets_ref
    AI->>St: run.started
    AI->>RR: aura.rpc.memory.recall
    RR-->>AI: items[]
    Note over AI: runTurn = createAgent (Node)
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
    AI-->>Conn: HTTP 2xx done body
    Conn->>Ev: aura.events.agent.invoke.done
    GW->>KV: release inflight
    Note over St,Client: 스트림은 유실 허용 · 감산/감사는 events
  end
```

실패 시 Function 비-2xx → connector가 `aura.events.agent.invoke.error`로 적재. poison은 MaxDeliver 후 `aura.dlq.>` Term(ARCHITECTURE §3.2).

와이어 상세: [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) · [`deploy/docs/agent-invoke-create-agent.md`](deploy/docs/agent-invoke-create-agent.md) · [`deploy/docs/mcp-tools-list.md`](deploy/docs/mcp-tools-list.md) · [`deploy/docs/gateway-sse-ws.md`](deploy/docs/gateway-sse-ws.md).

---

## 4. MQT: 커넥터 파드 vs Function 파드

MQT마다 **역할이 다른 두 Deployment**가 있다. KEDA가 스케일하는 대상은 **커넥터**다.

```mermaid
sequenceDiagram
  participant Pub as Publisher
  participant JS as JetStream AURA_TASKS
  participant KEDA as KEDA ScaledObject
  participant Conn as Connector Deployment
  participant Router as Fission Router
  participant Fn as Function Pod<br/>env + fetcher

  Pub->>JS: publish aura.tasks.*
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
| **Function** | 핸들러 실행 (env + fetcher). **현재=`node-env`**; 후속 `python-env` / `rust-env` 가능 — connector와 독립 | executor(`poolmgr`)·env pool |

동기 `aura.rpc.*`에는 MQT/JetStream ScaledObject를 **붙이지 않는다**(No Responders). NATS 구독은 **`aura-nats-rpc-bridge`만** — Fission Router로 Sync Function(`poolmgr`) 중계.

multi-env 후속: [`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md).

---

## 5. 메모리 파이프라인 (async)

`agent_invoke`는 메모리를 PG에 쓰지 않는다. capture → (event) → store/embed.

```mermaid
sequenceDiagram
  participant AI as agent_invoke
  participant T as AURA_TASKS
  participant Cap as memory_capture
  participant Ev as AURA_EVENTS
  participant Store as svc-memory store
  participant Embed as svc-memory embed
  participant PG as Pooler→PG

  AI->>T: aura.tasks.memory.capture
  Note over Cap: MQT · PG 금지
  Cap->>Ev: aura.events.memory.candidates
  Note over Store: 후보 관찰 후 store 태스크<br/>(구현·트리거는 DESIGN)
  Store->>T: aura.tasks.memory.store
  Store->>PG: set_config tenant local + INSERT
  Store->>Ev: aura.events.memory.stored
  Embed->>T: aura.tasks.memory.embed
  Embed->>PG: embedding upsert
  Embed->>Ev: aura.events.memory.embedded
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
| agent_invoke 순서 | [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) |
| mcp MQT+RPC | [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) |
| control.resolve | [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md) |
| LLM egress | [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md) |
