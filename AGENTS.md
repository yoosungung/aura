# AGENTS.md

This file provides guidance to AI coding assistants (Claude Code, Codex, Gemini, ...) when working with code in this repository. `CLAUDE.md`와 `GEMINI.md`는 이 파일로의 심볼릭 링크다 — 정본은 `AGENTS.md` 하나.

에이전트·기여자가 **무엇을 어디서 읽고 어떻게 실행하는지**만 담는다. 불변 규칙은 [ARCHITECTURE.md](ARCHITECTURE.md), 일정은 [ROADMAP.md](ROADMAP.md).

## 1. Documentation layout (문서 용도)

각 문서는 하나의 명확한 용도만 가진다. 같은 내용을 여러 문서에 중복하지 않는다. 한쪽을 고칠 때 다른 쪽이 같이 바뀌어야 한다면 잘못 나눈 것이므로 합치거나 한쪽이 다른 쪽을 참조하게 만든다.

| 파일 | 용도 | 위치 |
|------|------|------|
| `AGENTS.md` (이 파일, 정본) ← `CLAUDE.md`, `GEMINI.md` 심볼릭 | 수행 방법 + 문서 레이아웃 + 현황 | 루트 |
| `ARCHITECTURE.md` | **계약사항(불변 규칙)** + 컴포넌트 *간* 인터페이스 형태(스키마·레이아웃·이벤트) | 루트 |
| `MESSAGE-FLOW.md` | 전체 시스템 **메시지·호출 흐름** 다이어그램 (채널·E2E·MQT 파드·메모리·RPC) | 루트 |
| `README.md` | 저장소 방문자용 소개 + 로컬 quickstart | 루트 |
| `ROADMAP.md` | 수행 계획(마일스톤·순서·미결정 항목) | 루트 |
| `<comp>/DESIGN.md` | 컴포넌트 *내부* 설계 + `## Commands` | 코드 진입 시: `services/memory/`, `services/control/`, `runtimes/` 등 |
| `deploy/SETUP.md` | 클러스터 부트스트랩 런북 (NATS·KEDA·Fission) | `deploy/` |
| `deploy/docs/` | 배포·스모크 **계획** 문서 (… · **multi-env** [`multi-env-followup.md`](deploy/docs/multi-env-followup.md) · **nats-task-bridge** · **관리 UI MVP** [`admin-ui-mvp.md`](deploy/docs/admin-ui-mvp.md)) | `deploy/docs/` |
| `deploy/sql/` | 메모리·컨트롤·런타임 PG DDL (… · **`source_meta`/`user_meta`/`control_audit`** · **`agent_checkpoints`**) | `deploy/sql/` |
| `deploy/k8s/` | **제품** 매니페스트 (NATS base · PG · memory/agent/mcp/gateway …) — 프로덕션 후보 | `deploy/k8s/` |
| `deploy/k8s/base/` | NATS JetStream Kustomize | `deploy/k8s/base/` |
| `deploy/k8s/runtime-envs/` | Fission 런타임×계급 공용 Environment — `aura-nodejs-async|sync` · `aura-python-async|sync` (후속 custom) | `deploy/k8s/runtime-envs/` |
| `deploy/k8s/nats-rpc-bridge/` | 공용 NATS Core RR→Fission Router 브리지 (`aura-nats-rpc-bridge` replicas≥2 · **ns `aura`** · deps 포함 이미지) | `deploy/k8s/nats-rpc-bridge/` |
| `deploy/k8s/nats-task-bridge/` | agent/mcp async JetStream→Router 브리지 (`aura-nats-task-bridge` · runtime→Function · **ns `aura`**) | `deploy/k8s/nats-task-bridge/` |
| `services/nats-rpc-bridge/` | RPC 브리지 DESIGN + `bridge.js` (중계만 · handler 금지 · runtime 매핑) | `services/nats-rpc-bridge/` |
| `services/nats-task-bridge/` | task 브리지 DESIGN + consumer (중계만 · handler 금지) | `services/nats-task-bridge/` |
| `deploy/k8s/agent-invoke-py/` · `mcp-invoke-py/` · `mcp-invoke-rpc-py/` | Python 병행 Function/Package (**MQT 없음** · task/rpc 브리지) | `deploy/k8s/` |
| `deploy/dev/` | **smoke·로컬 하네스만** (프로덕션 제외) — [`deploy/dev/README.md`](deploy/dev/README.md) | `deploy/dev/` |
| `deploy/dev/k8s/async-smoke/` | async MQT echo (`aura.tasks.smoke` → resp/error, `minReplicaCount=0`) | `deploy/dev/k8s/async-smoke/` |
| `deploy/dev/k8s/sync-smoke/` | sync Warm (`newdeploy` MinScale≥2) + Core RR Deployment `aura-rpc-smoke-rr` (MQT 없음) | `deploy/dev/k8s/sync-smoke/` |
| `deploy/k8s/pg-pooler/` | CNPG `Cluster` `aura-pg` + `Pooler` `aura-pg-pooler` (transaction) + DSN ConfigMap · HA draft `cluster-ha.draft.yaml` · PITR restore draft `cluster-pitr-restore.draft.yaml` | `deploy/k8s/pg-pooler/` |
| `deploy/k8s/memory-store/` | `svc-memory` store MQT (`aura.tasks.memory.store` → stored/error, `minReplicaCount=0`, `set_config(..., true)`) | `deploy/k8s/memory-store/` |
| `deploy/k8s/memory-capture/` | `memory_capture` MQT (`aura.tasks.memory.capture` → candidates/error, `minReplicaCount=0`, **PG 금지**) | `deploy/k8s/memory-capture/` |
| `deploy/k8s/memory-embed/` | `svc-memory` embed MQT (`aura.tasks.memory.embed` → embedded/error, `minReplicaCount=0`, **short_term 스킵**) | `deploy/k8s/memory-embed/` |
| `deploy/k8s/memory-recall/` | `svc-memory` recall Function (`aura-memory-recall`, **poolmgr sync**, NATS는 공용 브리지) | `deploy/k8s/memory-recall/` |
| `deploy/k8s/agent-invoke/` | `agent_invoke` Node Function (`aura-agent-invoke` · `aura-nodejs-async`; subject=`aura.tasks.agent.invoke` via **task-bridge**; PG=`agent_checkpoints`만) | `deploy/k8s/agent-invoke/` |
| `deploy/k8s/mcp-invoke/` | `mcp_invoke` Node async Function (`aura-mcp-invoke` · task-bridge; **PG 금지**) | `deploy/k8s/mcp-invoke/` |
| `deploy/k8s/mcp-invoke-rpc/` | `mcp_invoke` Node RPC Function (`aura-mcp-invoke-rpc`, **poolmgr sync**, NATS는 공용 브리지) | `deploy/k8s/mcp-invoke-rpc/` |
| `deploy/k8s/control-resolve/` | `aura-control-resolve` Function (**poolmgr sync**, NATS는 공용 브리지) | `deploy/k8s/control-resolve/` |
| `deploy/k8s/gateway/` | Gateway Deployment+Service (**ns `aura`**, `replicas≥2`, **MQT 없음**, **PG 없음**; SSE/WS 브리지) | `deploy/k8s/gateway/` |
| `services/memory/` | `svc-memory` 내부 DESIGN + store/embed/recall handlers | `services/memory/` |
| `services/memory-capture/` | `memory_capture` 내부 DESIGN + handler (PG 금지 · candidates envelope) | `services/memory-capture/` |
| `services/control/` | `svc-control` DESIGN + resolve/브리지 + **관리 HTTP** + **pooler-lookup** + `control_audit` | `services/control/` |
| `services/admin-ui/` | 플랫폼 ops Admin UI MVP (Tenant picker · sources · bundles · overlays) | `services/admin-ui/` |
| `deploy/k8s/control-admin/` | `aura-control-admin` Deployment+Service (관리 HTTP · replicas≥2 · **ns `aura`**) | `deploy/k8s/control-admin/` |
| `services/agent-invoke/` | `agent_invoke` DESIGN + `nodejs/` · `python/` · testdata · checkpoints · archive | `services/agent-invoke/` |
| `services/llm-gateway/` | LLM Gateway 내부 DESIGN + client egress 가드 + Fallback/과금 집계 (`aura-llm-gateway`만) | `services/llm-gateway/` |
| `services/otel/` | OTel attribute 허용 목록 + Function·NATS·PG span 빌더 (`maskSecrets` 재사용) | `services/otel/` |
| `services/compliance/` | `compliance.erase` 초안 — OpenBao Transit crypto-shred + content_ref | `services/compliance/` |
| `deploy/k8s/compliance-erase/` | `aura.tasks.compliance.erase` MQT (`minReplicaCount=0`) | `deploy/k8s/compliance-erase/` |
| `services/mcp-invoke/` | `mcp_invoke` DESIGN + `nodejs/` · `python/` (async+RPC 공유 tool path · PG 금지) | `services/mcp-invoke/` |
| `services/gateway/` | Gateway 내부 DESIGN + `run_id`/SSE/WS/principal (`gateway.js`) | `services/gateway/` |
| `deploy/scripts/` | `install-runtime.sh` · `ensure-streams.sh` · `apply-product.sh` · `check-*.sh` · `smoke-*.sh` (… · **svc-control resolve** · **admin-ui-mvp** · **control.resolve 브리지** · **agent_invoke** · **gateway** 포함) | `deploy/scripts/` |

규칙:

- **ARCHITECTURE.md §1 (계약) vs §2 이후 (형태).** §1은 "지켜야 하는 규칙(왜)" — 짧고 단정적. §2 이후는 "그 규칙을 구현하는 모양(어떻게)" — 스키마·필드·이벤트 목록. 규칙이 바뀌면 §1을 먼저 고치고 §2 이후를 따라 고친다.
- **ARCHITECTURE.md vs `<comp>/DESIGN.md`.** ARCHITECTURE는 컴포넌트 *간*, 서브폴더 DESIGN은 해당 컴포넌트 *내부*. 두 쪽에 같은 내용을 적지 않는다.
- **ARCHITECTURE.md vs MESSAGE-FLOW.md.** ARCHITECTURE는 계약·스키마·subject 표. MESSAGE-FLOW는 **흐름 다이어그램만** — subject/수치를 복사하지 않고 ARCHITECTURE를 참조한다.
- **README.md vs ARCHITECTURE.md / DESIGN.md.** README는 **인간 독자**용이다. 계약·내부 설계는 README에 복사하지 않고 링크로만 둔다.
- **배포 가능한 패키지·실행 하네스**에는 README를 둘 수 있다 — 해당 디렉터리 **로컬 사용법만**.
- **`deploy/k8s/` = 제품**, **`deploy/dev/` = smoke·로컬 하네스**. 스모크 매니페스트를 `deploy/k8s/`에 두지 않는다. 프로덕션 apply 경로에 `deploy/dev/`·`apply-split-deploy.sh`·`smoke-*.sh`를 넣지 않는다.
- **Fission Environment는 `deploy/k8s/runtime-envs/` 런타임×계급 공용** (`aura-nodejs-*` · `aura-python-*`; 후속 custom). 서비스별 Environment·서비스별 `*-rr` Deployment를 추가하지 않는다. sync RPC는 `aura-nats-rpc-bridge` → Fission Router → sync Function(`poolmgr`)만. agent/mcp async는 `aura-nats-task-bridge` → Router(언어별 MQT 금지).
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
M3 진행: **`svc-control` resolve** · **`aura.rpc.control.resolve` 브리지** [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md) · `check-control-resolve-bridge.sh` · **`agent_invoke` MQT** · **`agent_checkpoints` DDL** [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md) · `check-agent-checkpoints.sh` · **`mcp_invoke` 이원화** [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) · `check-mcp-invoke-dual.sh` · **mcp Streamable HTTP** [`deploy/docs/mcp-streamable-http.md`](deploy/docs/mcp-streamable-http.md) · `check-mcp-streamable-http.sh` · **MCP·번들 격리 정책** [`deploy/docs/mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md) · `check-mcp-bundle-isolation.sh` · **Egress 차단 검증** · **LLM Gateway** [`deploy/docs/egress-block-verify.md`](deploy/docs/egress-block-verify.md) · `check-egress-block-verify.sh` · **LLM Gateway 최소** [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md) · `check-llm-gateway.sh` · **NATS mTLS + 시크릿 mask/TTL** [`deploy/docs/nats-mtls-secrets.md`](deploy/docs/nats-mtls-secrets.md) · `check-nats-mtls-secrets.sh` · **Gateway `run_id`/SSE/WS** · **Gateway Fair Queue/RL** [`deploy/docs/gateway-fair-queue.md`](deploy/docs/gateway-fair-queue.md) · `check-gateway-fair-queue.sh` · **inflight `release` + `ensureAdmitted` 우회** [`deploy/docs/gateway-inflight-release.md`](deploy/docs/gateway-inflight-release.md) · `check-gateway-inflight-release.sh` (live NATS done 구독·live provider·CNI FQDN 라이브 프로브=후속).
M3.5 진행: Node **`createAgent` runTurn** · Package **archive** · MCP **`tools/list`** · live NATS/Node RPC 워커 · **`agent_checkpoints` writer/resume** ([`deploy/docs/agent-invoke-create-agent.md`](deploy/docs/agent-invoke-create-agent.md)).  
M3.6 진행: **python-env 병행** · `source_meta.runtime` · task/rpc 브리지 runtime→Function · `services/*/nodejs|python` · **custom image=container executor** · 브리지 `function` 접두사 allowlist ([`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md)).  
M4 진행: consolidate/graph/TTL/archive/object_gc/shared-bucket · **OTel** · **compliance.erase** · **PITR 드릴 #1(lab) 실측** [`deploy/docs/pg-pitr-drill.md`](deploy/docs/pg-pitr-drill.md) · `check-pg-pitr-drill.sh` · [`services/ops/pitr-drill/`](services/ops/pitr-drill/) (Collector live·erase 운영화·CNPG/Barman 스케일 재드릴=M5).
M5 진행: **LLM Gateway Fallback + 테넌트 과금 대시보드** · **고위험 RuntimeClass/노드풀** · **DLQ Replay** · **정기 PITR 캘린더** (NATS Account=잔여).  
M6 진행: **관리 UI ops-only MVP** [`deploy/docs/admin-ui-mvp.md`](deploy/docs/admin-ui-mvp.md) · `check-admin-ui-mvp.sh` · 관리 HTTP · 서버 checksum activate · `control_audit` · resolve Pooler SELECT · [`services/admin-ui/`](services/admin-ui/).  
다음: M3.5 잔여 스모크 · async 콜드 p95 · Fission MQT Term 미들웨어 · store/embed 실 DDL INSERT · M5 잔여(NATS Account 후보) · M6 live Garage/Pooler.

요약 계약: NATS 삼원화+DLQ; Fair Queue; LLM Gateway; 샌드박스/mTLS; PG Pooler+HA; GDPR erase; Warm sync SLA; `svc-memory`; 수명 파티션; iterative_scan; edges 가드. NATS Account는 출시 후.
