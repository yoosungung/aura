# AGENTS.md

This file provides guidance to AI coding assistants (Claude Code, Codex, Gemini, ...) when working with code in this repository. `CLAUDE.md`와 `GEMINI.md`는 이 파일로의 심볼릭 링크다 — 정본은 `AGENTS.md` 하나.

에이전트·기여자가 **무엇을 어디서 읽고 어떻게 실행하는지**만 담는다. 불변 규칙은 [ARCHITECTURE.md](ARCHITECTURE.md), 일정은 [ROADMAP.md](ROADMAP.md).

## 1. Documentation layout (문서 용도)

각 문서는 하나의 명확한 용도만 가진다. 같은 내용을 여러 문서에 중복하지 않는다. 한쪽을 고칠 때 다른 쪽이 같이 바뀌어야 한다면 잘못 나눈 것이므로 합치거나 한쪽이 다른 쪽을 참조하게 만든다.

| 파일 | 용도 | 위치 |
|------|------|------|
| `AGENTS.md` (이 파일, 정본) ← `CLAUDE.md`, `GEMINI.md` 심볼릭 | 수행 방법 + 문서 레이아웃 + 현황 | 루트 |
| `ARCHITECTURE.md` | **계약사항(불변 규칙)** + 컴포넌트 *간* 인터페이스 형태(스키마·레이아웃·이벤트) | 루트 |
| `README.md` | 저장소 방문자용 소개 + 로컬 quickstart | 루트 |
| `ROADMAP.md` | 수행 계획(마일스톤·순서·미결정 항목) | 루트 |
| `<comp>/DESIGN.md` | 컴포넌트 *내부* 설계 + `## Commands` | 코드 진입 시: `services/memory/`, `services/control/`, `runtimes/` 등 |
| `deploy/SETUP.md` | 클러스터 부트스트랩 런북 (NATS·KEDA·Fission) | `deploy/` |
| `deploy/docs/` | 배포·스모크 **계획** 문서 (PG+Pooler · Multi-AZ/PITR 초안 · **memory TTL 수치** · **graph 순회 한도** · **embeddings 세대 교체** · **short_term embed 가드·iterative_scan** · **HNSW 왜곡 픽스처** · **Agent 주입 슬롯·토큰 예산** · **Object Store/`content_ref`** · **고아 GC** · **svc-control resolve** · **control.resolve 브리지** · **agent_invoke MQT/스트림 프레임** · **`agent_checkpoints` DDL** · **mcp_invoke MQT+RPC** · **mcp Streamable HTTP 어댑터** · **MCP·번들 격리(gVisor/Kata·Egress)** · **Gateway SSE/WS·run_id·principal**) | `deploy/docs/` |
| `deploy/sql/` | 메모리·컨트롤·런타임 PG DDL (`memory_items` LIST+RANGE+RLS · `memory_audit` 월 RANGE+RLS · `memory_nodes`/`memory_edges`+RLS+out/in indexes · `memory_embeddings` LIST+RLS · **`source_meta`/`user_meta`** · **`agent_checkpoints`**) | `deploy/sql/` |
| `deploy/k8s/base/` | NATS JetStream Kustomize | `deploy/k8s/base/` |
| `deploy/k8s/async-smoke/` | async MQT echo (`aura.tasks.smoke` → resp/error, `minReplicaCount=0`) | `deploy/k8s/async-smoke/` |
| `deploy/k8s/sync-smoke/` | sync Warm (`newdeploy` MinScale≥2) + Core RR Deployment `aura-rpc-smoke-rr` (MQT 없음) | `deploy/k8s/sync-smoke/` |
| `deploy/k8s/pg-pooler/` | CNPG `Cluster` `aura-pg` + `Pooler` `aura-pg-pooler` (transaction) + DSN ConfigMap · HA draft `cluster-ha.draft.yaml` | `deploy/k8s/pg-pooler/` |
| `deploy/k8s/memory-store/` | `svc-memory` store MQT (`aura.tasks.memory.store` → stored/error, `minReplicaCount=0`, `set_config(..., true)`) | `deploy/k8s/memory-store/` |
| `deploy/k8s/memory-capture/` | `memory_capture` MQT (`aura.tasks.memory.capture` → candidates/error, `minReplicaCount=0`, **PG 금지**) | `deploy/k8s/memory-capture/` |
| `deploy/k8s/memory-embed/` | `svc-memory` embed MQT (`aura.tasks.memory.embed` → embedded/error, `minReplicaCount=0`, **short_term 스킵**) | `deploy/k8s/memory-embed/` |
| `deploy/k8s/memory-recall/` | `svc-memory` recall RPC (`aura.rpc.memory.recall`, `newdeploy` MinScale≥2 + Deployment `aura-memory-recall-rr`, **MQT 없음**) | `deploy/k8s/memory-recall/` |
| `deploy/k8s/agent-invoke/` | `agent_invoke` MQT (`aura.tasks.agent.invoke` → done/error, `minReplicaCount=0`, 메모리 PG 금지·**`agent_checkpoints`만 예외**; 스트림=`aura.stream.<run_id>` Core) | `deploy/k8s/agent-invoke/` |
| `deploy/k8s/mcp-invoke/` | `mcp_invoke` MQT (`aura.tasks.mcp.invoke` → done/error, `minReplicaCount=0`, **PG 금지**) | `deploy/k8s/mcp-invoke/` |
| `deploy/k8s/mcp-invoke-rpc/` | `mcp_invoke` RPC (`aura.rpc.mcp.tool`, `newdeploy` MinScale≥2 + Deployment `aura-mcp-invoke-rr`, **MQT 없음**) | `deploy/k8s/mcp-invoke-rpc/` |
| `deploy/k8s/control-resolve/` | `aura.rpc.control.resolve` 브리지 (`newdeploy` MinScale≥2 + Deployment `aura-control-resolve-rr`, **MQT 없음**) | `deploy/k8s/control-resolve/` |
| `deploy/k8s/gateway/` | Gateway Deployment+Service (`replicas≥2`, **MQT 없음**, **PG 없음**; SSE/WS 브리지) | `deploy/k8s/gateway/` |
| `services/memory/` | `svc-memory` 내부 DESIGN + store/embed/recall handlers | `services/memory/` |
| `services/memory-capture/` | `memory_capture` 내부 DESIGN + handler (PG 금지 · candidates envelope) | `services/memory-capture/` |
| `services/control/` | `svc-control` 내부 DESIGN + resolve wire 헬퍼 + **control.resolve 브리지** (`source_meta`/`user_meta`) | `services/control/` |
| `services/agent-invoke/` | `agent_invoke` 내부 DESIGN + handler (resolve/recall/mcp injectable · 스트림 프레임 · done envelope) | `services/agent-invoke/` |
| `services/mcp-invoke/` | `mcp_invoke` 내부 DESIGN + handler (async MQT + sync RPC 공유 tool path · PG 금지) | `services/mcp-invoke/` |
| `services/gateway/` | Gateway 내부 DESIGN + `run_id`/SSE/WS/principal (`gateway.js`) | `services/gateway/` |
| `deploy/scripts/` | `install-runtime.sh` · `install-pg-pooler.sh` · `ensure-streams.sh` · `apply-split-deploy.sh` · `check-*.sh` · `smoke-*.sh` (memory store/embed/guard/HNSW·TTL·graph·pooler · **svc-control resolve** · **control.resolve 브리지** · **agent_invoke** · **agent_checkpoints** · **gateway SSE/WS** 포함) | `deploy/scripts/` |

규칙:

- **ARCHITECTURE.md §1 (계약) vs §2 이후 (형태).** §1은 "지켜야 하는 규칙(왜)" — 짧고 단정적. §2 이후는 "그 규칙을 구현하는 모양(어떻게)" — 스키마·필드·이벤트 목록. 규칙이 바뀌면 §1을 먼저 고치고 §2 이후를 따라 고친다.
- **ARCHITECTURE.md vs `<comp>/DESIGN.md`.** ARCHITECTURE는 컴포넌트 *간*, 서브폴더 DESIGN은 해당 컴포넌트 *내부*. 두 쪽에 같은 내용을 적지 않는다.
- **README.md vs ARCHITECTURE.md / DESIGN.md.** README는 **인간 독자**용이다. 계약·내부 설계는 README에 복사하지 않고 링크로만 둔다.
- **배포 가능한 패키지·실행 하네스**에는 README를 둘 수 있다 — 해당 디렉터리 **로컬 사용법만**.
- 파일이 새로 생기거나 용도가 바뀌면 위 표를 즉시 갱신한다.
- 배포 런북은 `deploy/SETUP.md`, Kustomize는 `deploy/k8s/base/`, CI는 `.github/workflows/ci.yml`. **빈 stub을 만들지 않는다** — 실제 절차·매니페스트가 생길 때 작성한다.

## 2. 수행 방법 (How we work in this repo)

- 계획·설계·구현 변경은 해당 문서를 먼저(또는 함께) 고친다: 계획 → `ROADMAP.md`, 설계·규칙 → `ARCHITECTURE.md` 또는 `<comp>/DESIGN.md`, 워크플로 → 이 파일.
- 코드가 처음 들어오는 컴포넌트는 그 폴더의 `DESIGN.md`를 함께 만들고, 필요 시 이 파일 §1 표·`ARCHITECTURE.md` §1을 갱신한다.
- 컴포넌트에 첫 코드가 들어오면 `DESIGN.md`에 **`## Commands`** 를 추가한다. 그 전까지 존재하지 않는 명령을 만들지 않는다.
- 개발은 TDD다. (스켈레톤 → 테스트 → 구현)
- 한국어/영어 혼용 허용. 한 문서 내 일관성(한국어 본문 + 영어 식별자).

### 참고 저장소 (계승 금지)

아이디어만 참고한다. 스키마·코드를 복사·이식하지 않는다.

- 로컬 `aura_old` (구 헬프데스크 Aura)
- [yoosungung/agent-runtime](https://github.com/yoosungung/agent-runtime)

## 3. Status

**기획 문서 고정 완료** — [ARCHITECTURE.md](ARCHITECTURE.md)·[ROADMAP.md](ROADMAP.md)·[README.md](README.md).

M0: NATS·KEDA·Fission 설치 + 스트림 + async/sync 분리(V0.1) + async echo/poison + V0.2 sync Core RR + **V0.4 `AURA_DLQ` ① Term** + **PG+Pooler 스모크 계획** 완료.  
M1 진행: BM25=`tsvector` 확정 · **Pooler=CNPG `Pooler` transaction** + [`deploy/k8s/pg-pooler`](deploy/k8s/pg-pooler/) · `check-pg-pooler.sh` · **V1.1 RLS 실측** · **Multi-AZ/PITR 초안** · **`memory_items` LIST+월 RANGE+RLS** · **`memory_audit` 월 RANGE+RLS** · **`memory_nodes`/`memory_edges`+RLS** · **edges out/in partial + 순회 한도** · **`memory_embeddings` LIST+세대 교체** [`deploy/docs/memory-embeddings-generation.md`](deploy/docs/memory-embeddings-generation.md) · **활성 임베딩 핀** [`deploy/docs/memory-embedding-active.md`](deploy/docs/memory-embedding-active.md) (`BAAI/bge-m3`/`1`/`1024`) · **TTL 수치** [`deploy/docs/memory-ttl-policy.md`](deploy/docs/memory-ttl-policy.md) (14d/24mo/12mo) · **short_term embed 가드 + iterative_scan/`ef_search=40`** [`deploy/docs/memory-embed-guard-iterative-scan.md`](deploy/docs/memory-embed-guard-iterative-scan.md) · **HNSW 왜곡 픽스처** [`deploy/docs/memory-hnsw-multitenant-fixture.md`](deploy/docs/memory-hnsw-multitenant-fixture.md) · **`services/memory` store MQT** [`services/memory/DESIGN.md`](services/memory/DESIGN.md) · `check-memory-store.sh`.  
M2 진행: **`memory_capture` MQT** [`services/memory-capture/DESIGN.md`](services/memory-capture/DESIGN.md) · `check-memory-capture.sh` · **embed MQT** [`services/memory/DESIGN.md`](services/memory/DESIGN.md) · `check-memory-embed.sh` (`short_term` 스킵) · **recall hybrid RRF** `check-memory-recall.sh` · **Agent 주입 계약** [`deploy/docs/agent-inject-contract.md`](deploy/docs/agent-inject-contract.md) · `check-agent-inject-contract.sh` (2048/512/768/768 · 패킹=M3) · **Object Store=Garage** [`deploy/docs/object-store-content-ref.md`](deploy/docs/object-store-content-ref.md) · `check-object-store-content-ref.sh` (V2.1 · provision 보류) · **고아 GC V2.2** [`deploy/docs/object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md) · `check-object-store-orphan-gc.sh` (구현=M4).  
M3 진행: **`svc-control` resolve** · **`aura.rpc.control.resolve` 브리지** [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md) · `check-control-resolve-bridge.sh` · **`agent_invoke` MQT** · **`agent_checkpoints` DDL** [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md) · `check-agent-checkpoints.sh` · **`mcp_invoke` 이원화** [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) · `check-mcp-invoke-dual.sh` · **mcp Streamable HTTP** [`deploy/docs/mcp-streamable-http.md`](deploy/docs/mcp-streamable-http.md) · `check-mcp-streamable-http.sh` · **MCP·번들 격리 정책** [`deploy/docs/mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md) · `check-mcp-bundle-isolation.sh` · **Gateway `run_id`/SSE/WS** · **Gateway Fair Queue/RL** [`deploy/docs/gateway-fair-queue.md`](deploy/docs/gateway-fair-queue.md) · `check-gateway-fair-queue.sh` · **inflight `release` + `ensureAdmitted` 우회** [`deploy/docs/gateway-inflight-release.md`](deploy/docs/gateway-inflight-release.md) · `check-gateway-inflight-release.sh` (live NATS done 구독·Egress 실측·LLM 후속).
다음: async 콜드 p95 · Fission MQT Term 미들웨어 · store/embed 실 DDL INSERT · 체크포인트 writer/resume · Egress 차단 검증 · LLM Gateway.

요약 계약: NATS 삼원화+DLQ; Fair Queue; LLM Gateway; 샌드박스/mTLS; PG Pooler+HA; GDPR erase; Warm sync SLA; `svc-memory`; 수명 파티션; iterative_scan; edges 가드. NATS Account는 출시 후.
