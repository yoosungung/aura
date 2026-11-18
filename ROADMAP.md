# ROADMAP.md

Aura **Agent + MCP Serverless Runtime** 수행 계획. 계약 정본은 [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 결정 로그

| 날짜 | 결정 | 근거 |
|------|------|------|
| 2026-11-17 | 제품 = Agent/MCP Serverless Runtime reboot (헬프데스크 계승 아님) | 기획 확정 |
| 2026-11-17 | 메모리 = Alibaba 4유형 (`short_term`/`long_term`/`episodic`/`semantic`), 단일 PG + vector + BM25 + graph | 기획 확정 |
| 2026-11-17 | 메모리 PG 유일 쓰기 = `svc-memory`; 컨트롤 메타 = `svc-control` | 기획 확정 |
| 2026-11-17 | **Serverless = Fission + KEDA NATS JetStream MQT** (OpenFaaS·bare KEDA Deployment 폴백 없음) | 기획 확정 |
| 2026-11-17 | **실행 이원화**: `aura.tasks.*` = MQT + scale-to-zero; `aura.rpc.*` = Core RR + **minReplicas ≥ 2** (RPC에 scale-to-zero 금지) | P0: Core RR은 JetStream lag로 깨울 수 없음 → No Responders |
| 2026-11-17 | **임베딩 = 방안 B**: `memory_embeddings` LIST 파티션(`model_key`) + 파티션별 `halfvec(N)` 표현식 HNSW. 부모는 차원 미지정 `halfvec`. `vector` HNSW·단일 `vector(1536)` 고정 테이블 rewrite 경로 비채택 | pgvector: 무차원 컬럼 직접 HNSW 불가; vector HNSW≤2000 / halfvec≤4000; 10년 모델 교체 시 DETACH/DROP |
| 2026-11-17 | **PG 접근 = Connection Pooler 필수** (PgBouncer 또는 CNPG Pooler, transaction pooling). RLS는 `set_config('app.tenant_id', $1, true)`만. Function→PG 직접 연결·세션 GUC 금지 | FaaS 오토스케일 시 max_connections 고갈·풀 재사용 테넌트 오염 |
| 2026-11-17 | **UX 스트림 = `aura.stream.<run_id>`** (NATS Core, 유실 허용) + Gateway SSE/WS 브리지. 완료 정본은 `aura.events.agent.invoke.done`. 대화형 기본은 스트림 필수 | 배치 done-only는 수초~수십 초 UX 불가 |
| 2026-11-17 | **메모리 파티션·TTL**: items=`memory_type` LIST(+ short/episodic 월 RANGE); audit=월 RANGE; short_term **비-HNSW**; 콜드 episodic=Parquet 아카이브 후 DETACH/DROP. Soft delete만으로 bloat 방치 금지 | HNSW RAM/인덱스 비대화·OOM 방지, 10년 운영 |
| 2026-11-17 | **멀티테넌트 HNSW**: 공유 `model_key` + **pgvector ≥0.8 `hnsw.iterative_scan`** 필수; 앱 post-filter 금지. M1 왜곡 테넌트 픽스처 검증. 실패 시 T1 테넌트 해시 파티션 / T2 whale 분리 | 소형 테넌트 전역 Top-K post-filter → Recall 0 |
| 2026-11-17 | **그래프 순회 방어**: edges out+**in** partial(`valid_until IS NULL`); max_depth=2, per_hop_limit=50, visited, supernode cap. M1 인덱스·한도 수치 고정, M4 구현 | 슈퍼노드 1–2홉 fan-out 폭발 |
| 2026-11-17 | **테넌트 Fair Queue**: Gateway Token Bucket + max_inflight **필수**(NATS Account와 독립). 상태=NATS KV 권장. SLO 미달 시 F1 테넌트 subject 샤딩 | 공유 AURA_TASKS FIFO → noisy neighbor 기아 |
| 2026-11-17 | **P2 엔터프라이즈**: 샌드박스(gVisor/Kata)+Egress NP; NATS mTLS·시크릿 TTL 캐시; GDPR content_ref+crypto-shred; **LLM Gateway**; sync Warm p95 < 1–2s; PG Multi-AZ/PITR; MaxDeliver+AURA_DLQ | 1만+/10년 보안·비용·컴플라이언스 |
| (M1) | iterative_scan + **PG HA/RPO/RTO 초안** (활성 임베딩 실값은 2026-11-18 행) | M1에서 고정 (BM25·Pooler 제품은 2026-11-18 확정) |
| 2026-11-17 | **sync Warm 단일 홉 p95 ≈ 0.6ms** (`smoke-sync-rpc.sh` n=20, Core local). 연쇄 목표 p95 < 1–2s 유지. async 콜드 p95는 별도 기입 | V0.2 스모크 |
| 2026-11-18 | **PG + Pooler 스모크 계획** 문서화 — [`deploy/docs/pg-pooler-smoke-plan.md`](deploy/docs/pg-pooler-smoke-plan.md) (설치·제품 확정·실측은 M1 V1.1) | M0 권장 체크 |
| 2026-11-18 | **BM25/전문 = stock `tsvector` + `GIN` + `ts_rank`/`ts_rank_cd`** (`content_tsv`). ParadeDB/`pg_search` **M1 비채택** | §6 DDL 기본과 일치; 추가 확장·`shared_preload`·CNPG ImageVolume(PG18+) 없이 Pooler/RLS M1과 병행 가능. 순수 Okapi BM25 품질 갭이 실측되면 이후 `pg_search` 재평가 |
| 2026-11-18 | **Pooler 제품 = CloudNativePG `Pooler`** (`spec.pgbouncer.poolMode: transaction`). 앱 DSN 호스트 = **pooler Service only** (`aura-pg-pooler…`). standalone PgBouncer는 CNPG 미도입 폴백만 | M1 PG HA/PITR과 동일 operator; §2.1·[`deploy/k8s/pg-pooler`](deploy/k8s/pg-pooler/)·`check-pg-pooler.sh`. V1.1 RLS 실측은 `92cccf21` |
| 2026-11-18 | **PG Multi-AZ / PITR 토폴로지 초안** — instances=3 + zone anti-affinity; Barman Cloud WAL+base; **RPO ≤ 5m · RTO ≤ 1h**; recall = RO Pooler(`type: ro`) | §9.6·[`deploy/docs/pg-ha-pitr-topology.md`](deploy/docs/pg-ha-pitr-topology.md)·`cluster-ha.draft.yaml`. 라이브 apply·PITR 드릴 실측은 후속/M4. 비용·리전 실값 비범위 |
| 2026-11-18 | **메모리 TTL 수치 M1 고정** — short_term 핫 **14일** · episodic 핫 **24개월** · audit 핫 **12개월**; DROP 판정=`U <= now()-핫간격`; DROP 주기 **일 1회**; 담당=`aura.tasks.memory.ttl` (구현=M4) | §6.2.2·[`deploy/docs/memory-ttl-policy.md`](deploy/docs/memory-ttl-policy.md)·`check-memory-ttl.sh`. Soft-delete-only 방치 금지 |
| 2026-11-18 | **그래프 순회 한도 M1 고정** — `idx_memory_edges_out`/`in` partial(`valid_until IS NULL`); max_depth=**2** · per_hop_limit=**50** · max_nodes_total=**100** · max_edges_total=**200** · supernode_degree_cap=**64** · visited; walk 구현=M4 | §6.2.4·[`deploy/docs/memory-graph-traversal.md`](deploy/docs/memory-graph-traversal.md)·`check-memory-graph-traversal.sh` |
| 2026-11-18 | **memory_embeddings 세대 교체 절차 M1 고정** — LIST(`model_key`)+파티션 `halfvec(N)` HNSW; ATTACH→active 전환→DETACH; 생산 `AURA_EMBEDDING_*` 실값은 별도 체크 | §6.2.1·[`deploy/docs/memory-embeddings-generation.md`](deploy/docs/memory-embeddings-generation.md)·`check-memory-embeddings.sh` |
| 2026-11-18 | **short_term embed 거부 + iterative_scan/ef_search M1 고정** — DDL CHECK로 `short_term` 제외; embed Function 스킵=M2; pgvector **≥0.8**; `hnsw.iterative_scan=relaxed_order`; `hnsw.ef_search=**40**`; `max_scan_tuples=**20000**`; 앱 post-filter 금지 | §6.2.3·§6.3·[`deploy/docs/memory-embed-guard-iterative-scan.md`](deploy/docs/memory-embed-guard-iterative-scan.md)·`check-memory-embed-guard.sh` |
| 2026-11-18 | **멀티테넌트 HNSW 픽스처 PASS (L2)** — A=2000 + B=2 · `halfvec_l2` · `LIMIT 10` · ON(`relaxed_order`) B≥1 · OFF B=0; 기본=공유 `model_key`+iterative_scan. **갭:** 생산 `halfvec_cosine` 동일 왜곡은 ON 미달 관측 → cosine 재실측 또는 T1/T2 후보(스키마 미적용) | §6.2.3·[`deploy/docs/memory-hnsw-multitenant-fixture.md`](deploy/docs/memory-hnsw-multitenant-fixture.md)·`check-memory-hnsw-multitenant.sh` |
| 2026-11-18 | **활성 임베딩 M1 고정** — `AURA_EMBEDDING_MODEL=BAAI/bge-m3` · `version=1` · `dims=1024` · `model_key=BAAI/bge-m3:1` (dense only). TTL 수치는 기존 로그·`memory-ttl-policy.md` 유지 | 클러스터 TEI `bge-m3-tei` + HF model card dims=1024 · [`deploy/docs/memory-embedding-active.md`](deploy/docs/memory-embedding-active.md)·`check-memory-embedding-active.sh` |
| 2026-11-19 | **Agent 주입 계약 M2 고정** — recall `items[]`만 주입; 원문/`content_ref` 덤프 금지; 슬롯 short_term **512** · episodic **768** · long_term+semantic **768**(합 **2048**); 아이템 short **4** · `top_k` **12**; 패킹 구현=M3 | §1 #9·§6.3 · [`deploy/docs/agent-inject-contract.md`](deploy/docs/agent-inject-contract.md)·`check-agent-inject-contract.sh` |
| 2026-11-19 | **Object Store = Garage** (S3/SigV4). 버킷 `aura-content` · 키 `tenants/{tenant_id}/refs/…`(+ archive prefix 공유) · Barman=`aura-pg` 분리. 256KB 초과/`PII` → `content_ref` only. 라이브 provision·NCP/AWS 비용=`@eric` 보류 | V2.1 · §8 · [`deploy/docs/object-store-content-ref.md`](deploy/docs/object-store-content-ref.md)·`check-object-store-content-ref.sh` |
| 2026-11-19 | **고아 content_ref GC 설계 M2 고정** — grace **90일**(`AURA_EVENTS` 정합) · prefix=`refs/` only · live PG 참조 시 스킵 · 배치 100/일 · 태스크=`aura.tasks.memory.object_gc` · 멱등 `object-gc:{tenant\|all}:{yyyy-mm-dd}` (구현=M4) | V2.2 · [`deploy/docs/object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md)·`check-object-store-orphan-gc.sh` |
| 2026-11-19 | **`svc-control` 최소 resolve API/스키마 M3 고정** — `source_meta`/`user_meta` DDL+RLS · resolve wire(`control.resolve.done`) · 1-depth cfg merge(user wins) · `secrets_ref` only · 브리지 Warm은 별 항목 | [`deploy/docs/svc-control-resolve.md`](deploy/docs/svc-control-resolve.md)·`control_meta.sql`·`check-svc-control-resolve.sh` |
| 2026-11-19 | **`aura.rpc.control.resolve` 브리지 Warm M3 고정** — subject/queue `aura-control-resolve` · **MinScale≥2** + Deployment `aura-control-resolve-rr` replicas≥2 · MQT 금지 · stub/injectable handler · live Pooler SELECT=후속 | [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md)·`check-control-resolve-bridge.sh` · `deploy/k8s/control-resolve/` |
| 2026-11-19 | **`agent_invoke` MQT + 스트림 프레임 M3 고정** — topic `aura.tasks.agent.invoke` · Core `aura.stream.<run_id>` (`run.started`/`token`/`tool.*`/`run.completed`) · resolve/recall/mcp RPC injectable · done=`aura.events.agent.invoke.done` · V3.1 token-before-done · Gateway SSE/Fair Queue/live LLM=후속 | [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md)·`check-agent-invoke.sh` · [`services/agent-invoke/`](services/agent-invoke/) |
| 2026-11-19 | **Gateway `run_id`/SSE/WS/principal M3 고정** — UUIDv7 발급 · exact `aura.stream.<run_id>` · 소유 principal만 구독 · Deployment replicas≥2 · Fair Queue/live NATS=후속 | [`deploy/docs/gateway-sse-ws.md`](deploy/docs/gateway-sse-ws.md)·`check-gateway-sse-ws.sh` · [`services/gateway/`](services/gateway/) |
| 2026-11-19 | **Gateway Fair Queue/RL M3 고정** — Token Bucket 10/s·burst 30·maxInflight 20 · CAS KV `quota.{tenant_id}` · 429 · 노이지 픽스처(A 기아≠B) · live NATS KV·done 구독=후속 | [`deploy/docs/gateway-fair-queue.md`](deploy/docs/gateway-fair-queue.md)·`check-gateway-fair-queue.sh` |
| 2026-11-19 | **inflight `release` + `ensureAdmitted` 우회 재확인 M3 고정** — terminal stream/event → `release`(멱등) · `agent_invoke` poison 429 · live done 구독 Deployment=후속 | [`deploy/docs/gateway-inflight-release.md`](deploy/docs/gateway-inflight-release.md)·`check-gateway-inflight-release.sh` |
| 2026-11-19 | **`mcp_invoke` 이원화 M3 고정** — MQT `aura.tasks.mcp.invoke`/`aura_mcp_invoke`/`minReplicaCount=0` · sync `aura.rpc.mcp.tool` Warm **MinScale≥2**+`aura-mcp-invoke-rr` · PG 금지 · 외부 Streamable HTTP=후속 | [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md)·`check-mcp-invoke-dual.sh` · [`services/mcp-invoke/`](services/mcp-invoke/) |
| 2026-11-19 | **외부 MCP Streamable HTTP 어댑터 M3 고정** — Spec `2025-06-18` · `tools/call` POST · JSON/SSE · cfg `transport`/`mcp_endpoint` · injectable fetch · initialize/sandbox/Egress=후속 | [`deploy/docs/mcp-streamable-http.md`](deploy/docs/mcp-streamable-http.md)·`check-mcp-streamable-http.sh` · [`services/mcp-invoke/streamable-http.js`](services/mcp-invoke/streamable-http.js) |
| 2026-11-19 | **`aura.rpc.control.resolve` 브리지 M3 고정** — Core RR `aura-control-resolve-rr` **replicas≥2** · Warm `MinScale≥2` · queue-group `aura-control-resolve` · stub/injectable `bridge.js` · Pooler SELECT=후속 | [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md)·`check-control-resolve-bridge.sh` · [`services/control/`](services/control/) |
| 2026-11-19 | **`agent_checkpoints` 예외 테이블 DDL M3 고정** — 이름=`agent_checkpoints` · FORCE RLS · UNIQUE(tenant,run,seq) · kind turn/tool/final · state JSONB+`content_ref`(256KB+) · writer=`agent_invoke` only · Pooler+`set_config` · writer/resume=후속 | §1 #10·§6.1.2 · [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md)·`agent_checkpoints.sql`·`check-agent-checkpoints.sh` |
| (M0) | async 콜드 p95 기입 | M0 잔여 |

---

## M0 — Fission 부트스트랩 (async MQT + sync RPC 이원화)

**목표**: Fission·KEDA·NATS를 올리고, ARCHITECTURE §4 두 계급이 **분리 배포**로 스모크된다. 프레임워크 재선택 스파이크가 아니다.

**작업**

- [x] K8s에 NATS JetStream, KEDA, Fission 설치 (`deploy/SETUP.md` · `deploy/scripts/install-runtime.sh`)
- [x] 스트림 `AURA_TASKS` / `AURA_EVENTS` / **`AURA_DLQ`** 사전 생성 (`deploy/scripts/ensure-streams.sh` · `smoke-streams.sh`)
- [x] **분리 배포**: async MQT Function(scale-to-zero 가능)과 sync Warm Function(`aura.rpc.*`, minReplicas≥2)을 **별 매니페스트/별 ScaledObject**로 둔다 — 동일 Deployment에 0과 ≥2를 섞지 않음 (`deploy/k8s/async-smoke` · `deploy/k8s/sync-smoke` · `check-split-deploy.sh`)
- [x] **Async**: 샘플 Function + MQT — `aura.tasks.smoke` → echo → `resptopic` / `errortopic` (`deploy/k8s/async-smoke/echo.js` · `smoke-async-mqt.sh`)
- [x] **Async poison**: 파싱 불가/고의 실패 → 유한 재시도 + **`errortopic` 잔존** (`smoke-async-poison.sh`; `AURA_DLQ` 택일은 `1632b9ee`)
- [x] **Sync**: 샘플 RPC — `aura.rpc.smoke`, **`minReplicas >= 2`**, JetStream MQT·lag scaler **미연결** (`aura-rpc-smoke-rr` · `smoke-sync-rpc.sh`)
- [x] pull consumer·RPC queue-group·DLQ subject·분리 배포 이름 문서화 (`deploy/SETUP.md`)
- [x] (권장) PG + Pooler 스모크 계획 — 본문은 M1 ([`deploy/docs/pg-pooler-smoke-plan.md`](deploy/docs/pg-pooler-smoke-plan.md))
- [x] **DLQ 적재 경로 확정**(아래 유의사항) → 결정 로그 1행 · `smoke-dlq-term.sh`

**구현 유의사항 (착수 시 확인)**

1. **Sync RPC Executor** — Fission 기본 `poolmgr`는 HTTP specialize 전까지 NATS에 안 붙는다. `aura.rpc.*`(V0.1·V0.2)는 기동 즉시 Core queue-group subscribe가 필요하므로 **`newdeploy`(minScale ≥ 2)** 또는 ARCHITECTURE §4.3의 **동일 이미지 명시 Deployment**로 띄운다. poolmgr+scale-to-zero로 sync를 검증하지 않는다.
2. **MaxDeliver → `AURA_DLQ`는 JetStream 자동 이관이 아님** — 초과 시 재전달만 중단되고 `$JS.EVENT.ADVISORY…`가 난다. **택일 확정(①):** 함수/미들웨어가 마지막 delivery에서 payload를 `AURA_DLQ`로 복사한 뒤 `Term()`/`Ack`로 원본 격리. ② Advisory 구독기는 **비채택**(WorkQueue에서 MaxDeliver 후 payload 유실·별도 구독기).
3. **결정 로그 (2026-11-17, V0.3 격리):** MQT `maxRetries` 소진 → **`errorTopic` 잔존** + consumer `MaxDeliver=5`(`ensure-async-consumer.sh`)로 무한 재시도 차단을 입증. `AURA_DLQ` 적재는 본 슬라이스 범위 밖(병행·비충돌).
4. **결정 로그 (2026-11-17, DLQ 적재 ①):** MaxDeliver 초과 격리 = **handler Term 경로** — 마지막 delivery에서 `aura.dlq.>` publish 후 Term. 증거 `smoke-dlq-term.sh` (전용 filter `aura.tasks.dlq_term_smoke`; MQT/`errorTopic` 비침범). Fission MQT 미들웨어 이식은 후속.
5. **결정 로그 (2026-11-17, V0.2 sync):** Core RR 응답자는 Fission node-env가 아닌 **명시 Deployment `aura-rpc-smoke-rr`**(nats-box `nats reply -q`, replicas≥2). Function `aura-rpc-smoke` newdeploy는 Warm Pool 분리 불변용.

**검증 체크리스트 (권고 반영)**

| # | 검증 | 합격 |
|---|------|------|
| V0.1 | async MQT와 sync Warm Function **분리 배포** | 매니페스트/네임스페이스 라벨로 구분; sync에 JetStream ScaledObject 없음 |
| V0.2 | sync **No Responders 방지** | Warm 상태에서 RR 성공; sync를 0으로 내리면 즉시 실패(회귀) |
| V0.3 | MaxDeliver 초과 격리 | 워커 무한 재시도 없음; `errortopic` 잔존 (`smoke-async-poison.sh` PASS) |
| V0.4 | `AURA_DLQ` 적재 경로 | **① Term** 확정; `smoke-dlq-term.sh` PASS; Advisory(②)·JS 자동 이관 금지 |

**성공 기준 — async (MQT)**

1. JetStream 메시지 1건 → Function 논리 처리(at-least-once; 멱등 키 범위 명시)
2. `resptopic` / `errortopic` envelope
3. lag 스케일 아웃 관측
4. idle 시 **replica 0**
5. 재시작 후 durable로 미처리 재개
6. **콜드 p95 < 15s** 측정·기입 (async 전용; 대화 체감 정본 아님)
7. V0.3 합격

**성공 기준 — sync (Core RR)**

1. 요청자 → `aura.rpc.smoke` → 응답 (No Responders 없음) — V0.2
2. 응답자 replica 0 → 즉시 No Responders 회귀
3. `minReplicas >= 2`에서 1파드 종료 시 RR 유지
4. **Warm Pool 단일 홉 p95** 및 (가능하면) 연쇄 목표 **p95 < 1~2s** 측정·결정 로그 기입
5. V0.1 합격(분리 배포)

**완료 시**: 위 체크·수치를 채우고 AGENTS Status를 M0 완료로 갱신.

---

## M1 — `svc-memory` + PG 메모리 스키마

**목표**: [ARCHITECTURE.md](ARCHITECTURE.md) §6 DDL(유형/월 파티션 + 방안 B 임베딩)을 적용하고, `svc-memory` store가 Pooler 경유로 쓴다.

**작업**

- [x] BM25 구현체 결정 → 결정 로그 기입 (`tsvector`+`ts_rank`; ParadeDB M1 비채택)
- [x] **CloudNativePG `Pooler`** Transaction Pooling 설치 매니페스트; 앱 DSN = pooler only → 결정 로그에 제품명 기입 (`deploy/k8s/pg-pooler` · `install-pg-pooler.sh` · `check-pg-pooler.sh`; V1.1 RLS 실측=`92cccf21`)
- [x] **통합 테스트**: Pooler + `SELECT set_config('app.tenant_id', $1, true)` + RLS — 커넥션 재사용 후 타 테넌트 행 미노출 (`rls-smoke-fixture.sql` · `smoke-pg-pooler.sh`)
- [x] PG **Multi-AZ / PITR** 토폴로지 + RPO/RTO 초안 (recall Read Replica 계획) — [`deploy/docs/pg-ha-pitr-topology.md`](deploy/docs/pg-ha-pitr-topology.md)
- [x] `memory_items` **LIST(memory_type)** + short_term/episodic **월 RANGE** 파티션 + RLS (`deploy/sql/memory_items.sql` · `check-memory-items.sh` · `smoke-memory-items.sh`)
- [x] `memory_audit` **월 RANGE** 파티션 + RLS (`deploy/sql/memory_audit.sql` · `check-memory-audit.sh` · `smoke-memory-audit.sh`)
- [x] **short_term 만료 정리 정책** 문서화: 핫 일수·월 파티션 DROP 주기·담당 태스크(`aura.tasks.memory.ttl`) — [`deploy/docs/memory-ttl-policy.md`](deploy/docs/memory-ttl-policy.md) · `check-memory-ttl.sh`
- [x] `memory_nodes` / `memory_edges` 마이그레이션 + RLS (`deploy/sql/memory_nodes_edges.sql` · `check-memory-nodes-edges.sh` · `smoke-memory-nodes-edges.sh`)
- [x] edges **`idx_memory_edges_out` / `idx_memory_edges_in`** (partial `valid_until IS NULL`); 순회 한도 DESIGN(§6.2.4) — [`deploy/docs/memory-graph-traversal.md`](deploy/docs/memory-graph-traversal.md) · `check-memory-graph-traversal.sh`
- [x] **`memory_embeddings` 차원/파티션 DDL 확정**: LIST(`model_key`) + 파티션별 `halfvec(N)` HNSW; **모델 세대 교체**(새 파티션 ATTACH → 전환 → 구형 DETACH) 절차를 DESIGN/런북에 고정 — [`deploy/docs/memory-embeddings-generation.md`](deploy/docs/memory-embeddings-generation.md) · `check-memory-embeddings.sh` · `smoke-memory-embeddings.sh` (fixture만; 생산 dims=별도 체크)
- [x] **short_term embed 거부** 가드; pgvector **≥ 0.8**; `ef_search` / `iterative_scan` DESIGN — [`deploy/docs/memory-embed-guard-iterative-scan.md`](deploy/docs/memory-embed-guard-iterative-scan.md) · `check-memory-embed-guard.sh` · `smoke-memory-embed-guard.sh`
- [x] **멀티테넌트 HNSW 픽스처**: 대형 A + 소형 B — ON≥1 / OFF 대조 회귀; 실패 시 T1/T2 — [`deploy/docs/memory-hnsw-multitenant-fixture.md`](deploy/docs/memory-hnsw-multitenant-fixture.md) · `check-memory-hnsw-multitenant.sh` · `smoke-memory-hnsw-multitenant.sh`
- [x] 활성 `AURA_EMBEDDING_MODEL` / `version` / `dims` → 결정 로그 (TTL 수치는 `memory-ttl-policy.md` 고정) — [`deploy/docs/memory-embedding-active.md`](deploy/docs/memory-embedding-active.md) · `check-memory-embedding-active.sh` (`BAAI/bge-m3` · `1` · `1024`)
- [x] `services/memory/DESIGN.md` + store MQT — 매 트랜잭션 `set_config(..., true)` (`services/memory/` · `deploy/k8s/memory-store/` · `check-memory-store.sh`)
- [x] (스모크) 무차원 HNSW 실패; short_term→embed 거부 (`smoke-memory-embed-guard.sh`; live 또는 `SMOKE_MEMORY_EMBED_GUARD_STATIC=1`)

**검증 체크리스트 (권고 반영)**

| # | 검증 | 합격 |
|---|------|------|
| V1.1 | CNPG Pooler transaction pooling + RLS `set_config(..., true)` | 풀 재사용 후 테넌트 오염 없음; `set_config(..., false)` 경로 없음 |
| V1.2 | 임베딩 세대 교체 DDL | 제2 `model_key` 파티션 추가·HNSW·전환·DETACH 문서/스크립트 존재(실측 또는 dry-run) |
| V1.3 | items/audit 파티션 + short_term 만료 정책 | 비파티션 힙 없음; DROP/TTL 정책이 DESIGN에 수치와 함께 명시 |

**성공 기준**

- `svc-memory` 외 쓰기 거부; store 멱등; short_term 비-임베딩.
- V1.1–V1.3 합격.
- **소형 테넌트 B recall ≥1** (iterative_scan); 앱 post-filter 없음.

---

## M2 — capture + embed + recall (+ Object Store 계약)

**목표**: capture → store/embed → recall hybrid. **256KB/`content_ref` Object Store 제품·GC**를 이 단계에서 확정한다(M3 직전으로 미루지 않음).

**작업**

- [x] `memory_capture` Function (PG 금지, MQT) → `aura.events.memory.candidates` (`services/memory-capture/` · `deploy/k8s/memory-capture/` · `check-memory-capture.sh`)
- [x] embed Function (MQT) — **short_term 스킵**; episodic/long_term/semantic만 HNSW/BM25 (`services/memory/embed/` · `deploy/k8s/memory-embed/` · `check-memory-embed.sh`)
- [x] **recall RPC Function** 별도 배포: `minReplicas >= 2`, Core queue-group, MQT 없음 (`services/memory/recall/` · `deploy/k8s/memory-recall/` · `check-memory-recall.sh`)
- [x] recall: short_term=최근순; 나머지 hybrid RRF (+ graph stub); iterative_scan + tenant WHERE (`services/memory/recall/` · `check-memory-recall.sh`)
- [x] Agent 주입 계약(프롬프트 슬롯·토큰 예산) — [`deploy/docs/agent-inject-contract.md`](deploy/docs/agent-inject-contract.md) · `check-agent-inject-contract.sh` (패킹 구현=M3)
- [x] **Object Store 제품 확정**(Garage/S3/NCP 등) → 결정 로그; `content_ref` 스키마·권한 — **Garage** · [`deploy/docs/object-store-content-ref.md`](deploy/docs/object-store-content-ref.md) · `check-object-store-content-ref.sh` (라이브 provision 보류)
- [x] **고아 객체 GC 설계**: 이벤트/메모리 TTL(예: 90일) 후 미참조 `content_ref` 삭제 배치·멱등 키 — [`deploy/docs/object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md) · `check-object-store-orphan-gc.sh` (구현=M4)

**검증 체크리스트**

| # | 검증 | 합격 |
|---|------|------|
| V2.1 | Object Store 제품·버킷/경로 | 결정 로그 **Garage**; `aura-content`+`tenants/{tenant_id}/…`; 256KB 초과=`content_ref`만; `check-object-store-content-ref.sh` PASS |
| V2.2 | 90일(또는 정책일) 고아 GC 설계 | DESIGN/doc에 GC 쿼리/태스크·안전장치(참조 존재 시 스킵); `check-object-store-orphan-gc.sh` PASS |
| V2.3 | Agent 주입 슬롯·토큰 예산 | ARCHITECTURE §6.3 + doc에 2048/512/768/768·short=4·top_k=12; `check-agent-inject-contract.sh` PASS |

**성공 기준**

- capture DB 쓰기 없음; recall에 JetStream ScaledObject 없음; 유형별 예산 동작.
- V2.1–V2.3 합격 (V2.1–V2.3=고정).

---

## M3 — `agent_invoke` / `mcp_invoke` + 스트림 + Fair Queue + 샌드박스

**목표**: Agent 턴 + **`aura.stream.*` 토큰 스트리밍** + **테넌트 Rate Limit** + 외부/커스텀 MCP **Egress/샌드박스** 정의·검증.

**작업**

- [x] `svc-control` 최소 resolve API/스키마 (`source_meta`/`user_meta`) — [`deploy/docs/svc-control-resolve.md`](deploy/docs/svc-control-resolve.md) · `control_meta.sql` · `check-svc-control-resolve.sh`
- [x] `agent_invoke` MQT — recall/mcp/resolve RPC + **`aura.stream.<run_id>` 토큰/툴 프레임** 설계·구현 — [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) · [`services/agent-invoke/`](services/agent-invoke/) · `deploy/k8s/agent-invoke/` · `check-agent-invoke.sh`
- [x] Gateway: `run_id` 발급; SSE/WS 브리지 + principal 인가 — [`deploy/docs/gateway-sse-ws.md`](deploy/docs/gateway-sse-ws.md) · [`services/gateway/`](services/gateway/) · `deploy/k8s/gateway/` · `check-gateway-sse-ws.sh`
- [x] Gateway: **테넌트별 Rate Limiting** — Token Bucket + max_inflight(§2.2); NATS KV; 429; 노이지 픽스처 — [`deploy/docs/gateway-fair-queue.md`](deploy/docs/gateway-fair-queue.md) · `services/gateway/rate-limit.js` · `check-gateway-fair-queue.sh` (10/s·burst30·inflight20)
- [x] done/error 시 inflight 감산; 우회 시 `agent_invoke` 재확인 — [`deploy/docs/gateway-inflight-release.md`](deploy/docs/gateway-inflight-release.md) · `ensureAdmitted` · `check-gateway-inflight-release.sh`
- [x] 프레임 계약 확정: `run.started` / `token` / `tool.*` / `run.completed` + events done — [`deploy/docs/agent-invoke-mqt.md`](deploy/docs/agent-invoke-mqt.md) · `check-agent-invoke.sh`
- [x] `mcp_invoke` **이원화**: task(MQT) + rpc(`aura.rpc.mcp.tool`, minReplicas ≥ 2) — [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) · [`services/mcp-invoke/`](services/mcp-invoke/) · `deploy/k8s/mcp-invoke/` · `deploy/k8s/mcp-invoke-rpc/` · `check-mcp-invoke-dual.sh`
- [x] `aura.rpc.control.resolve` 브리지 minReplicas ≥ 2 — [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md) · [`services/control/`](services/control/) · `deploy/k8s/control-resolve/` · `check-control-resolve-bridge.sh`
- [x] 체크포인트 예외 테이블 DDL (§6) — [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md) · `agent_checkpoints.sql` · `check-agent-checkpoints.sh` (writer/resume=후속)
- [x] 외부 MCP Streamable HTTP 어댑터 — [`deploy/docs/mcp-streamable-http.md`](deploy/docs/mcp-streamable-http.md) · [`services/mcp-invoke/streamable-http.js`](services/mcp-invoke/streamable-http.js) · `check-mcp-streamable-http.sh`
- [ ] **외부/커스텀 MCP·번들 격리 수준 정의(문서+정책)**: Egress deny-default allowlist; gVisor/Kata(또는 동등) RuntimeClass; 플랫폼 서명 vs 커스텀 차등
- [ ] **Egress 차단 검증**: 샌드박스에서 LLM Gateway·NATS·Pooler·허용 MCP 호스트 외 연결 실패
- [ ] **LLM Gateway** 최소 + Function Egress는 Gateway만
- [ ] **NATS mTLS** + 시크릿 마스킹/TTL 캐시 무효화
- [ ] (선택 F1) 테넌트 subject 샤딩 — SLO 미달 시만

**검증 체크리스트 (권고 반영)**

| # | 검증 | 합격 |
|---|------|------|
| V3.1 | `aura.stream.*` 토큰 스트리밍 | 첫 `token`/`tool.started`가 done **이전**; Core(비-JetStream) |
| V3.2 | 테넌트별 Rate Limiting | A 폭주 시 B 기아 없음; 쿼터 없는 publish 경로 없음 |
| V3.3 | 커스텀/외부 MCP Egress·샌드박스 | 정책 문서 + 스모크에서 비허용 Egress 차단; 격리 수준(gVisor/Kata 등) 결정 로그 기입 |

**성공 기준**

- 번들/시크릿 plaintext invoke 없음; Agent→MCP는 NATS RR만.
- agent MQT는 0 가능, sync RPC는 0 불가.
- V3.1–V3.3 합격; LLM 직접 호출·시크릿 평문 로그 없음.

---

## M4 — consolidate / graph / TTL·아카이브 / 관측

**목표**: 승격·graph·**파티션 TTL/콜드 아카이브**·OTel.

**작업**

- [ ] `aura.tasks.memory.consolidate` — 유형 승격 규칙
- [ ] recall graph **방어적** 1–2홉: visited, per_hop_limit, supernode_degree_cap, 유효 predicate, out+in 인덱스 사용
- [ ] 슈퍼노드 픽스처: 허브 1노드에 엣지 ≫ cap → 쿼리 시간/반환 상한 준수(폭발 없음)
- [ ] `aura.tasks.memory.ttl` — 만료 short_term/episodic/audit **월 파티션 DROP**
- [ ] `aura.tasks.memory.archive` — 콜드 episodic → Object Storage Parquet → DETACH/DROP + `aura.events.memory.archived`
- [ ] `aura.tasks.memory.object_gc` — 유예 90일 미참조 `content_ref` 삭제 ([`object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md) 알고리즘)
- [ ] object store 버킷/경로 계약(번들 스토어와 공유 가능) → 결정 로그
- [ ] OTel (Function·NATS·PG) + 시크릿 마스킹 검증
- [ ] `aura.tasks.compliance.erase` 초안 — content_ref + crypto-shredding 키 파기 흐름
- [ ] PG 복구 드릴 1회(PITR) — RPO/RTO 실측

**성공 기준**

- consolidate 없이 `memory_type` 자동 변경 없음.
- TTL 후 해당 월 파티션 부재; Soft-delete-only로 핫 HNSW 행이 누적되지 않음.
- 아카이브 후 PG에 콜드 episodic 없고 object store에 Parquet 존재(스모크).
- 그래프 확장 depth≤2, 노드/엣지 상한·visited 준수; 슈퍼노드 픽스처에서 타임아웃/폭증 없음.
- erase 후 해당 유저/테넌트 핫 데이터·복호 가능 ciphertext 부재(스모크).
- 트레이스에 tenant/session/run id; 시크릿 평문 없음.

---

## M5 — 엔터프라이즈 경화 (P2 잔여)

**목표**: §9 잔여 — LLM Gateway Fallback/과금 고도화, 테넌트별 Pod 격리 정책, erase 운영화, Account 이전 단계.

**작업**

- [ ] LLM Gateway Fallback 모델 + 테넌트 과금 대시보드
- [ ] 고위험 테넌트 전용 RuntimeClass/노드풀 정책
- [ ] DLQ Replay 운영 도구 + 런북
- [ ] 정기 PG 복구 훈련 캘린더
- [ ] (출시 후 후보) NATS Account 격리 설계 착수

---

## 미결정

- ~~활성 임베딩 모델·version·dims(N) 실값~~ — **M1 고정** (`BAAI/bge-m3`/`1`/`1024` · [`deploy/docs/memory-embedding-active.md`](deploy/docs/memory-embedding-active.md))
- iterative_scan만으로 충분한지 vs T1/T2 승격 — **M1 픽스처 PASS**(공유+iterative_scan 유지; T1/T2=실패·KPI 시에만)
- 그래프 `per_hop_limit` / `supernode_degree_cap` 운영 튜닝 — **M1 수치 고정**([`deploy/docs/memory-graph-traversal.md`](deploy/docs/memory-graph-traversal.md)) → **M4 부하 후 조정**
- async 콜드스타트 p95 확정 수치 — **M0 측정 후**
- sync RPC 상한 스케일(HPA 메트릭: CPU vs RPS) — M2/M3 직전
- ~~Object store **아카이브 Parquet 경로가 번들/`content_ref`와 버킷 공유인지**~~ — **M2 고정:** 동일 `aura-content` 버킷 · prefix 분리(`refs/` vs `archive/` vs `bundles/`); Barman=`aura-pg` 비공유 ([`object-store-content-ref.md`](deploy/docs/object-store-content-ref.md)). ~~GC 설계~~ **고정** ([`object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md)) · 아카이브·GC 본구현=M4
- short_term/episodic/audit 핫 일수 운영 튜닝 — M1 정책 수립 → M4 부하 후 조정
- NATS account 격리 — **출시 후**
- 테넌트 rate/burst/inflight·플랜 tier 최종 숫자 — **M3 DESIGN**(기능은 M3 필수)
- F1 테넌트 subject 샤딩 — **M3 노이지 픽스처 후**
- gVisor vs Kata 최종 선택 — **M3 V3.3**
- sync 연쇄 p95 최종(1s vs 2s) — **M0 측정**
- RPO/RTO **드릴 실측으로 초안 교체** — 초안(≤5m/≤1h)은 M1 고정; 확정 실측 **M4**
- 암호화 키 KMS 제품 — **M4 erase 직전**

---

## 범위 밖 (초기)

LLM **가중치** 서빙/vLLM, Chat UI 풀스택, 헬프데스크 FSM/옴니채널, path-graph/VFS 통째 이식.  
범위 **안**: LLM Gateway, Parquet 아카이브, 샌드박스, mTLS, DLQ, PG HA, GDPR erase.
