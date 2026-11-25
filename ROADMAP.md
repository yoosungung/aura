# ROADMAP.md

Aura **Agent + MCP Serverless Runtime** 수행 계획. 계약 정본은 [ARCHITECTURE.md](ARCHITECTURE.md).

체크리스트(factory `pm-roadmap-sync`): `- [ ]` 할 일 · `- [x]` 완료 · `- [-]` 취소/불필요/won't-do · `- [~]` 연기(임시; 가능하면 대상 `##`로 이동).

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
| 2026-11-19 | **MCP·번들 격리 수준 M3 고정** — RuntimeClass **기본=`gvisor`(`runsc`)** · 고위험=`kata` · Egress deny-default allowlist(NATS·Pooler·LLM Gateway·`aura-content`·등록 MCP·DNS) · 플랫폼 서명 vs 커스텀 차등(서명도 Egress 동일; 미서명+비샌드박스 금지). 라이브 NP/실측=후속 | §9.1 · [`deploy/docs/mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md)·`check-mcp-bundle-isolation.sh` |
| 2026-11-19 | **PG PITR 드릴 런북·게이트 M4** — restore draft `bootstrap.recovery`/`targetTime` · `check-pg-pitr-drill.sh` · smoke static | §9.6 · [`deploy/docs/pg-pitr-drill.md`](deploy/docs/pg-pitr-drill.md) |
| 2026-11-19 | **Egress 차단 검증 M3 고정** — NP deny-default + allow(NATS·Pooler·LLM Gateway·object-store·DNS·MCP proxy) · RuntimeClass 매니페스트 · 오프라인 `evaluate-egress` + `egress-allowlist` 스모크. CNI FQDN 라이브 프로브=후속 | §9.1 · [`deploy/docs/egress-block-verify.md`](deploy/docs/egress-block-verify.md)·`check-egress-block-verify.sh` · `deploy/k8s/sandbox-egress/` |
| 2026-11-19 | **memory consolidate 유형 승격 규칙 M4 고정** — 허용 `short_term`→`episodic`→`long_term`/`semantic` · `similarity_only` 금지 · soft_close+insert_promoted · recurrence `evidence_count`≥3 · MQT `aura.tasks.memory.consolidate` | §5 · [`deploy/docs/memory-consolidate-promotion.md`](deploy/docs/memory-consolidate-promotion.md)·`check-memory-consolidate.sh` · `services/memory/consolidate/` |
| 2026-11-19 | **recall graph 방어적 1–2홉 M4 고정** — visited · per_hop_limit=50 · supernode_degree_cap=64 · 유효 predicate · out+in · RRF graph 분기; 슈퍼노드 픽스처=후속 | §6.2.4 · [`deploy/docs/memory-graph-traversal.md`](deploy/docs/memory-graph-traversal.md)·`check-memory-graph-traversal.sh` · `services/memory/recall/graph-walk.js` |
| 2026-11-19 | **memory TTL 월 파티션 DROP M4** — short_term 14d / audit 12mo DROP · episodic needs_archive · `aura.tasks.memory.ttl` MQT · Soft-delete-only 금지 | §6.2.2·[`deploy/docs/memory-ttl-drop.md`](deploy/docs/memory-ttl-drop.md)·`check-memory-ttl.sh` · `services/memory/ttl/` |
| 2026-11-19 | **memory archive Parquet M4** — cold episodic → `aura-content` `archive/episodic/…` Put → DETACH/DROP · `aura.events.memory.archived` · Put 전 DROP 금지 | §6.2.2·§8·[`deploy/docs/memory-archive.md`](deploy/docs/memory-archive.md)·`check-memory-archive.sh` · `services/memory/archive/` |
| 2026-11-19 | **memory object_gc M4** — refs/ · grace 90d · batch 100 · live content_ref skip · DeleteObject · 멱등 `object-gc:{tenant}:{yyyy-mm-dd}` | §8·[`deploy/docs/memory-object-gc.md`](deploy/docs/memory-object-gc.md)·`check-object-store-orphan-gc.sh` · `services/memory/object-gc/` |
| 2026-11-19 | **Object Store 버킷/경로 M4 봉인** — 앱=`aura-content` **단일 버킷** · prefix `refs/`·`archive/`·`bundles/` 공유(번들 스토어 포함) · 용도별 버킷 비채택 · Barman=`aura-pg` 비공유 · `object_gc`=`refs/` only | §8 · [`deploy/docs/object-store-content-ref.md`](deploy/docs/object-store-content-ref.md)·`check-object-store-content-ref.sh` |
| 2026-11-19 | **PG PITR 드릴 #1(lab)** — measured RPO≈3.2s · RTO≈3.1s → 예산 **RPO ≤ 5m · RTO ≤ 1h 확정**(lab≠prod scale; CNPG/Barman 재드릴=M5) | §9.6 · [`deploy/docs/pg-pitr-drill.md`](deploy/docs/pg-pitr-drill.md)·`check-pg-pitr-drill.sh` |
| 2026-11-19 | **슈퍼노드 픽스처 M4 고정** — hub_degree=**500** ≫ cap(64/50) · ON: candidates≤50·truncated·LIMIT≤50·wall&lt;2s · OFF=500 · `walkGraph` 폭증 없음 | §6.2.4·[`deploy/docs/memory-graph-supernode-fixture.md`](deploy/docs/memory-graph-supernode-fixture.md)·`check-memory-graph-supernode.sh` · `services/memory/recall/supernode-fixture.js` |
| 2026-11-19 | **memory TTL 월 파티션 DROP M4 고정** — short_term 14d / audit 12mo **DROP RESTRICT** · episodic 24mo cold=`needs_archive`(archive 후 DROP) · Soft-delete-only 금지 · MQT `aura.tasks.memory.ttl` / `aura_memory_ttl` · scale-to-zero | §6.2.2 · [`deploy/docs/memory-ttl-drop.md`](deploy/docs/memory-ttl-drop.md)·`check-memory-ttl.sh` · `services/memory/ttl/` · `deploy/k8s/memory-ttl/` |
| 2026-11-19 | **LLM Gateway 최소 M3 고정** — `POST /v1/chat/completions` · Function 클라이언트 provider blocklist · tenant RL · circuit · usage/cost 로그 · Deployment `aura-llm-gateway` replicas≥2. Fallback/과금 대시보드=M5 · live provider=후속 | §9.4 · [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md)·`check-llm-gateway.sh` · [`services/llm-gateway/`](services/llm-gateway/) |
| 2026-11-19 | **LLM Gateway Fallback + 테넌트 과금 대시보드 M5 고정** — `providers[]` 순서 Fallback · `fallbackModels` · `aura.attempts` · `GET /v1/billing/usage` 집계 · `renderBillingDashboard` · live provider 키 CI 비필수 | §9.4 · [`deploy/docs/llm-gateway-fallback-billing.md`](deploy/docs/llm-gateway-fallback-billing.md)·`check-llm-gateway-fallback-billing.sh` · [`services/llm-gateway/`](services/llm-gateway/) |
| 2026-11-19 | **고위험 테넌트 전용 RuntimeClass/노드풀 M5 고정** — `risk_tier=high`→`kata`+`aura.sandbox/pool=kata` label/taint/`scheduling` · standard=`gvisor` · Kata 풀 점유 금지 · 오프라인 placement selftest. live pool provision=후속 | §9.1 · [`deploy/docs/high-risk-tenant-nodepool.md`](deploy/docs/high-risk-tenant-nodepool.md)·`check-high-risk-tenant-nodepool.sh` · `deploy/k8s/sandbox-egress/` |
| 2026-11-19 | **DLQ Replay 운영 도구+런북 M5 고정** — Term envelope `src`/`echo` · dry-run/confirm · max_batch=20 · `aura.dlq.*` 거부 · Advisory/자동 루프 비채택 · live NATS CI 비필수 | §3.2·§9.7 · [`deploy/docs/dlq-replay.md`](deploy/docs/dlq-replay.md)·`check-dlq-replay.sh` · `dlq-replay.sh` · [`services/ops/dlq-replay/`](services/ops/dlq-replay/) |
| 2026-11-19 | **정기 PG 복구 훈련 캘린더 M5 고정** — cadence **quarterly≥1** · soft due_by=분기 말월 1일 UTC · 스택변경 follow-up **≤14일** · mode `cluster` 선호/`lab` 허용 · UI·자동 apply 비채택 · lab-1=2026-Q4 시드 | §9.6 · [`deploy/docs/pg-pitr-drill-calendar.md`](deploy/docs/pg-pitr-drill-calendar.md)·`check-pg-pitr-drill-calendar.sh` · [`services/ops/pitr-drill/calendar.js`](services/ops/pitr-drill/calendar.js) |
| 2026-11-19 | **NATS mTLS + 시크릿 마스킹/TTL 캐시 M3 고정** — overlay `tls { verify: true }` · `maskSecrets` · `createSecretsCache` TTL≤60s · `aura.events.control.secrets.rotated` 무효화 · live cert 클러스터 CI 필수 아님 | §9.2 · [`deploy/docs/nats-mtls-secrets.md`](deploy/docs/nats-mtls-secrets.md)·`check-nats-mtls-secrets.sh` · `deploy/k8s/nats-mtls/` · [`services/control/`](services/control/) |
| 2026-11-19 | **OTel (Function·NATS·PG) + 시크릿 마스킹 검증 M4** — `aura.tenant_id`/`session_id`/`run_id` 필수 · attribute 허용 목록 · `maskSecrets` 재사용 · DSN/`db.query.parameter.*` 금지 · Collector live=후속 | §9.2 · [`deploy/docs/otel-function-nats-pg.md`](deploy/docs/otel-function-nats-pg.md)·`check-otel-function-nats-pg.sh` · [`services/otel/`](services/otel/) |
| 2026-11-19 | **compliance.erase 초안 M4** — KMS=**OpenBao Transit** · kid `tenant:…:vN` / `tenant:…:user:…:vN` · shred→cache invalidate→PG redact→`refs/` Delete · 복호 가능 ciphertext 부재 · pending 24h · live OpenBao=후속 | §9.3 · [`deploy/docs/compliance-erase.md`](deploy/docs/compliance-erase.md)·`check-compliance-erase.sh` · [`services/compliance/`](services/compliance/) · `deploy/k8s/compliance-erase/` |
| 2026-11-19 | **`aura.rpc.control.resolve` 브리지 M3 고정** — Core RR `aura-control-resolve-rr` **replicas≥2** · Warm `MinScale≥2` · queue-group `aura-control-resolve` · stub/injectable `bridge.js` · Pooler SELECT=후속 | [`deploy/docs/control-resolve-bridge.md`](deploy/docs/control-resolve-bridge.md)·`check-control-resolve-bridge.sh` · [`services/control/`](services/control/) |
| 2026-11-19 | **`agent_checkpoints` 예외 테이블 DDL M3 고정** — 이름=`agent_checkpoints` · FORCE RLS · UNIQUE(tenant,run,seq) · kind turn/tool/final · state JSONB+`content_ref`(256KB+) · writer=`agent_invoke` only · Pooler+`set_config` · writer/resume=후속 | §1 #10·§6.1.2 · [`deploy/docs/agent-checkpoints.md`](deploy/docs/agent-checkpoints.md)·`agent_checkpoints.sql`·`check-agent-checkpoints.sh` |
| 2026-11-19 | **M3.5 Agent/MCP 본구현 (Node 먼저)** — `runTurn`=`createAgent`(LangChain.js) · Package=`node-builder`+**archive**(literal 폐기) · LLM=`assertFunctionLlmEgress`+Gateway client · `tools/list` 계약 · live NATS RR/stream · mcp-rr Node 워커 · `agent_checkpoints` writer/resume · **후속** python-env(M3.6)·rust-env PoC | [`deploy/docs/agent-invoke-create-agent.md`](deploy/docs/agent-invoke-create-agent.md) · [`deploy/docs/mcp-tools-list.md`](deploy/docs/mcp-tools-list.md) · [`deploy/docs/fission-node-archive.md`](deploy/docs/fission-node-archive.md) · [`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md) |
| 2026-11-20 | **M3.6 python-env 병행** — Node agent/MCP 유지 · `source_meta.runtime` 권위+메시지 스탬프 · 동일 NATS subject · task-bridge+rpc runtime→Function · `aura-python-async|sync` · `services/*/nodejs|python` · 브리지 deps 이미지 · custom-env 후속 | [`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md) · [`deploy/docs/nats-task-bridge.md`](deploy/docs/nats-task-bridge.md) · [`deploy/docs/fission-python-archive.md`](deploy/docs/fission-python-archive.md) |
| 2026-11-21 | **M3.6 후속 fastapi-env** — `aura-python-*` → `python-fastapi-env:1.35.0`+builder · `async def main(request)` · async Function `concurrency:4` · archive 유지 | [`deploy/docs/multi-env-followup.md`](deploy/docs/multi-env-followup.md) · [`deploy/docs/fission-python-archive.md`](deploy/docs/fission-python-archive.md) · `check-python-env-parity.sh` |
| 2026-11-22 | **공유 `agent_invoke` + cfg별 에이전트** — 조회 키 유지 · `cfg.system_prompt`/`model`/`tools` allowlist/`sub_agents` 참조 · 같은 `run_id` 깊이 2 · 스트림 `agent` · payload 스펙 거부 · 번들 factory는 GetObject 슬라이스 | §1 #18 · [`deploy/docs/agent-invoke-create-agent.md`](deploy/docs/agent-invoke-create-agent.md) · [`services/agent-invoke/DESIGN.md`](services/agent-invoke/DESIGN.md) |
| 2026-11-22 | **MCP 코드·cfg 선별** — 제3자 HTTP는 Function 안 Streamable HTTP · 서명 번들은 `factory(cfg, secrets_ref)` · 없으면 `mcp_backend_missing` · 미서명은 `bundle_untrusted` · Router/agent 직접 HTTP 없음 | §1 #12 · [`services/mcp-invoke/DESIGN.md`](services/mcp-invoke/DESIGN.md) · [`deploy/docs/mcp-invoke-dual.md`](deploy/docs/mcp-invoke-dual.md) |
| 2026-11-23 | **번들 GetObject + Pod LRU** — `aura-content`만 · 키=`checksum` · 값은 검증 바이트 · activate는 캐시 없음 · agent `module.path:attr` factory · `aura:createAgent`는 GetObject 스킵 · Garage 단일 노드 매니페스트 · CI는 이름 게이트만 | §8 · [`services/object-store/DESIGN.md`](services/object-store/DESIGN.md) · `check-object-store-garage.sh` · [`deploy/k8s/garage/`](deploy/k8s/garage/) |
| 2026-11-20 | **관리 UI 1차 MVP (ops-only) M6 고정** — Admin UI→`svc-control` HTTP→Pooler/Garage · 런타임 resolve는 NATS 유지 · `source_meta` 콘텐츠 불변·`status`만 `pending→active`/`active→retired` · activate 시 **서버 Garage sha256** · Tenant picker=`DISTINCT`∪`AURA_ADMIN_TENANT_IDS`∪UUID 입력 · `control_audit` append-only · resolve Pooler SELECT 동슬라이스 · tenants/ACL·과금 SPA·Chat UI 비범위 | §2·§6.1 · [`deploy/docs/admin-ui-mvp.md`](deploy/docs/admin-ui-mvp.md)·`check-admin-ui-mvp.sh` · [`services/control/`](services/control/) · [`services/admin-ui/`](services/admin-ui/) |
| 2026-11-20 | **Admin UI React 재설계 M6.1** — Vite+React+TS+Tailwind+shadcn · TanStack Query+Zustand+RHF/Zod · 전수 인벤토리 · PG=SoR · KV=`quota.*`는 Gateway만 · Phase2=control-admin HTTP→`aura.rpc.gateway.quota` · `GET /v1/audit` · Audit 화면 | §2·§6.1 · [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md)·`check-admin-ui.sh` · [`services/admin-ui/`](services/admin-ui/) |
| 2026-11-25 | **Admin UI quota 한도 수정 = 이번 범위 밖** — Phase 2 UI는 **조회+리셋만**(KV 카운터 · Gateway RR). `rate/burst/maxInflight` 등 **한도 수정**은 PG `tenant_plan`(후보) SoR + Gateway 재로드 후속. OIDC/SSO 제외 유지 · Tenant alias=`tenant_meta` DDL 방향 | [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md) · 아래 M6.2 후보 |
| 2026-11-25 | **`AURA_ADMIN_TENANT_IDS` 제거** — picker=`tenant_meta` ∪ `DISTINCT source_meta` ∪ UI UUID. env CSV seed 폐기 | [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md) · `control-admin` Deployment |
| 2026-11-25 | **`source_meta.function` 분리** — custom Router 이름 ≠ zip `entrypoint` · CHECK runtime 필드 · resolve top-level `function` · Admin Bundles UI 분기 | §1 #11 · §6.1.1 · [`deploy/sql/control_meta.sql`](deploy/sql/control_meta.sql) · [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md) |
| 2026-11-25 | **Tenant bundle scaffold + Download** — 로컬 단일 모듈 소스→Bundles 업로드 · Sources `GET …/bundle` 패치 보조 · Admin **Download scaffold**(SoT=`scaffolds/` 정적 미러) · multi-file zip 해제 Non-goal | [`deploy/docs/tenant-bundle-scaffold.md`](deploy/docs/tenant-bundle-scaffold.md) · [`scaffolds/`](scaffolds/) |
| (M0) | async 콜드 p95 기입 | M0 잔여 |

---

## M0 — Fission 부트스트랩 (async MQT + sync RPC 이원화)

**목표**: Fission·KEDA·NATS를 올리고, ARCHITECTURE §4 두 계급이 **분리 배포**로 스모크된다. 프레임워크 재선택 스파이크가 아니다.

**작업**

- [x] K8s에 NATS JetStream, KEDA, Fission 설치 (`deploy/SETUP.md` · `deploy/scripts/install-runtime.sh`)
- [x] 스트림 `AURA_TASKS` / `AURA_EVENTS` / **`AURA_DLQ`** 사전 생성 (`deploy/scripts/ensure-streams.sh` · `smoke-streams.sh`)
- [x] **분리 배포**: async MQT Function(scale-to-zero 가능)과 sync Warm Function(`aura.rpc.*`, minReplicas≥2)을 **별 매니페스트/별 ScaledObject**로 둔다 — 동일 Deployment에 0과 ≥2를 섞지 않음 (`deploy/dev/k8s/async-smoke` · `deploy/dev/k8s/sync-smoke` · `check-split-deploy.sh`; **dev smoke**, 제품은 `deploy/k8s/`)
- [x] **Async**: 샘플 Function + MQT — `aura.tasks.smoke` → echo → `resptopic` / `errortopic` (`deploy/dev/k8s/async-smoke/echo.js` · `smoke-async-mqt.sh`)
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
- [x] recall: short_term=최근순; 나머지 hybrid RRF (+ graph walk M4); iterative_scan + tenant WHERE (`services/memory/recall/` · `check-memory-recall.sh`)
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
- [x] **외부/커스텀 MCP·번들 격리 수준 정의(문서+정책)**: Egress deny-default allowlist; gVisor(`runsc`) 기본 · Kata 고위험 RuntimeClass; 플랫폼 서명 vs 커스텀 차등 — [`deploy/docs/mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md) · `check-mcp-bundle-isolation.sh`
- [x] **Egress 차단 검증**: 샌드박스에서 LLM Gateway·NATS·Pooler·허용 MCP 호스트 외 연결 실패 — [`deploy/docs/egress-block-verify.md`](deploy/docs/egress-block-verify.md) · `deploy/k8s/sandbox-egress/` · `check-egress-block-verify.sh` · `evaluate-egress.selftest.js` · `egress-allowlist.selftest.js`
- [x] **LLM Gateway** 최소 + Function Egress는 Gateway만 — [`deploy/docs/llm-gateway.md`](deploy/docs/llm-gateway.md) · [`services/llm-gateway/`](services/llm-gateway/) · `deploy/k8s/llm-gateway/` · `check-llm-gateway.sh` (Fallback/과금 → [`llm-gateway-fallback-billing.md`](deploy/docs/llm-gateway-fallback-billing.md))
- [x] **NATS mTLS** + 시크릿 마스킹/TTL 캐시 무효화 — [`deploy/docs/nats-mtls-secrets.md`](deploy/docs/nats-mtls-secrets.md) · [`services/control/`](services/control/) (`secrets-mask.js` · `secrets-cache.js` · `nats-tls.js`) · `deploy/k8s/nats-mtls/` · `check-nats-mtls-secrets.sh` (live cert apply=운영)
- [-] (선택 F1) 테넌트 subject 샤딩 — SLO 미달 시만 (미실시·SLO 게이트 미발화)

**검증 체크리스트 (권고 반영)**

| # | 검증 | 합격 |
|---|------|------|
| V3.1 | `aura.stream.*` 토큰 스트리밍 | 첫 `token`/`tool.started`가 done **이전**; Core(비-JetStream) |
| V3.2 | 테넌트별 Rate Limiting | A 폭주 시 B 기아 없음; 쿼터 없는 publish 경로 없음 |
| V3.3 | 커스텀/외부 MCP Egress·샌드박스 | 정책([`mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md))+`gvisor` 결정 로그 + 스모크([`egress-block-verify.md`](deploy/docs/egress-block-verify.md)·`check-egress-block-verify.sh` PASS=비허용 `egress_denied`) |

**성공 기준**

- 번들/시크릿 plaintext invoke 없음; Agent→MCP는 NATS RR만.
- agent MQT는 0 가능, sync RPC는 0 불가.
- V3.1–V3.3 합격; LLM 직접 호출·시크릿 평문 로그 없음.

---

## M3.5 — Agent/MCP 본구현 (Node `createAgent` → 이후 multi-env)

**목표**: `invokeOnce` 셸 유지 하에 **`runTurn` = LangChain.js `createAgent`**, MCP **`tools/list`+실경로**, live NATS·checkpoints writer/resume. Package는 **archive**. 이후 `python-env`/`rust-env`.

**작업**

- [x] 결정·문서 — archive 패키징 · `createAgent`+LLM egress · `tools/list` · PG 게이트(`memory_*` 금지·`agent_checkpoints`만) — [`deploy/docs/fission-node-archive.md`](deploy/docs/fission-node-archive.md) · [`deploy/docs/agent-invoke-create-agent.md`](deploy/docs/agent-invoke-create-agent.md) · [`deploy/docs/mcp-tools-list.md`](deploy/docs/mcp-tools-list.md)
- [x] Phase A — `createAgent` runTurn + Gateway egress 강제 TDD · MCP `tools/list` 스켈레톤 · archive Package + `check-*.sh` 개정
- [x] Phase B — live NATS helpers(`nats-deps.js`) · `aura-mcp-invoke-rr` nats-box→Node queue-group 워커(`rpc-worker.js`)
- [x] Phase C — `agent_checkpoints` writer/resume · MCP factory 실경로 + list/call + Streamable HTTP
- [x] M3.6 — python-env **병행** (Node 유지·동일 subject·resolve `runtime`·task/rpc 브리지) — 아래 §M3.6
- [x] 공유 Function + cfg별 에이전트 — `system_prompt`·툴 allowlist·서브에이전트 깊이 2 · 스트림 `agent` (§1 #18)
- [x] MCP 코드·cfg 선별 — HTTP / 서명 factory / `mcp_backend_missing` (§1 #12)
- [x] 번들 GetObject + Pod LRU — `aura-content` · agent/mcp 기본 `loadBundle` · Garage 매니페스트 · `check-object-store-garage.sh` ([`services/object-store/DESIGN.md`](services/object-store/DESIGN.md))
- [~] (후속) — `rust-env` 핫패스 PoC · `custom-env`

**성공 기준**

- Function→공급자 직접 호출 없음(`assertFunctionLlmEgress`).
- MQT connector ≠ Function 언어; archive 배포; RPC MinScale≥2 / MQT min=0 유지.
- `tools/list`로 스키마 수집 후 Agent 툴 바인딩 가능; checkpoints INSERT는 `agent_invoke`+Pooler만.
- 같은 `agent_invoke`가 cfg마다 다른 `system_prompt`·allowlist로 `createAgent`를 호출하고, 서브에이전트는 깊이 2에서 멈춘다.

---

## M3.6 — agent/MCP python-env 병행 (동일 NATS subject)

**목표**: Node agent/MCP 제품 경로 유지 + Python Function/Environment 병행. `source_meta.runtime` 권위 · 메시지 스탬프 · task/rpc 브리지 라우팅.

**작업**

- [x] 계약·문서 — Environment 런타임×계급 · task-bridge · `source_meta.runtime` · `services/*/nodejs|python`
- [x] `aura-python-async|sync` · apply allowlist · Python archive/Function
- [x] resolve/Gateway stamp · rpc/task bridge `runtime`→Function · 브리지 deps 이미지
- [x] 패리티 check (`check-python-env-parity.sh`)
- [x] fastapi-env 전환 — `python-fastapi-env:1.35.0` · `handler.main(request)` · async `concurrency:4`
- [~] (후속) custom-env Function 슬롯 · rust-env PoC

**성공 기준**

- 동일 subject로 `runtime=nodejs|python` invoke; 메시지 단독 언어 선택 없음.
- agent/mcp 언어별 MQT 이중 구독 없음; task-bridge는 handler 미포함.
- Node 회귀 smoke + Python 패리티 selftest 합격.
- Python Environment가 `python-fastapi-env:1.35.0`이며 async Function concurrency=4.

---

## M4 — consolidate / graph / TTL·아카이브 / 관측

**목표**: 승격·graph·**파티션 TTL/콜드 아카이브**·OTel.

**작업**

- [x] `aura.tasks.memory.consolidate` — 유형 승격 규칙 ([`deploy/docs/memory-consolidate-promotion.md`](deploy/docs/memory-consolidate-promotion.md) · `check-memory-consolidate.sh` · `services/memory/consolidate/`)
- [x] recall graph **방어적** 1–2홉: visited, per_hop_limit, supernode_degree_cap, 유효 predicate, out+in 인덱스 사용 ([`deploy/docs/memory-graph-traversal.md`](deploy/docs/memory-graph-traversal.md) · `check-memory-graph-traversal.sh` · `services/memory/recall/graph-walk.js`)
- [x] 슈퍼노드 픽스처: 허브 1노드에 엣지 ≫ cap → 쿼리 시간/반환 상한 준수(폭발 없음) ([`deploy/docs/memory-graph-supernode-fixture.md`](deploy/docs/memory-graph-supernode-fixture.md) · `check-memory-graph-supernode.sh` · `services/memory/recall/supernode-fixture.js`)
- [x] `aura.tasks.memory.ttl` — 만료 short_term/episodic/audit **월 파티션 DROP** — [`deploy/docs/memory-ttl-drop.md`](deploy/docs/memory-ttl-drop.md) · `services/memory/ttl/` · `deploy/k8s/memory-ttl/` · `check-memory-ttl.sh` (episodic cold=`needs_archive` until archive)
- [x] `aura.tasks.memory.archive` — 콜드 episodic → Object Storage Parquet → DETACH/DROP + `aura.events.memory.archived` ([`deploy/docs/memory-archive.md`](deploy/docs/memory-archive.md) · `check-memory-archive.sh` · `services/memory/archive/`)
- [x] `aura.tasks.memory.object_gc` — 유예 90일 미참조 `content_ref` 삭제 ([`object-store-orphan-gc.md`](deploy/docs/object-store-orphan-gc.md) · [`memory-object-gc.md`](deploy/docs/memory-object-gc.md) · `check-object-store-orphan-gc.sh` · `services/memory/object-gc/`)
- [x] object store 버킷/경로 계약(번들 스토어와 공유 가능) → 결정 로그 ([`object-store-content-ref.md`](deploy/docs/object-store-content-ref.md) · `check-object-store-content-ref.sh`)
- [x] OTel (Function·NATS·PG) + 시크릿 마스킹 검증 — [`deploy/docs/otel-function-nats-pg.md`](deploy/docs/otel-function-nats-pg.md) · `check-otel-function-nats-pg.sh` · [`services/otel/`](services/otel/)
- [x] `aura.tasks.compliance.erase` 초안 — content_ref + crypto-shredding 키 파기 흐름 ([`compliance-erase.md`](deploy/docs/compliance-erase.md) · `check-compliance-erase.sh` · [`services/compliance/`](services/compliance/) · `deploy/k8s/compliance-erase/`)
- [x] PG 복구 드릴 1회(PITR) — RPO/RTO 실측 ([`deploy/docs/pg-pitr-drill.md`](deploy/docs/pg-pitr-drill.md) · `check-pg-pitr-drill.sh` · `services/ops/pitr-drill/` · lab-1 RPO≈3.2s · RTO≈3.1s → 예산 ≤5m/≤1h 확정; CNPG/Barman 스케일 재드릴=M5)

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

- [x] LLM Gateway Fallback 모델 + 테넌트 과금 대시보드 — [`deploy/docs/llm-gateway-fallback-billing.md`](deploy/docs/llm-gateway-fallback-billing.md) · `check-llm-gateway-fallback-billing.sh` · [`services/llm-gateway/`](services/llm-gateway/)
- [x] 고위험 테넌트 전용 RuntimeClass/노드풀 정책 — [`deploy/docs/high-risk-tenant-nodepool.md`](deploy/docs/high-risk-tenant-nodepool.md) · `check-high-risk-tenant-nodepool.sh` · `deploy/k8s/sandbox-egress/runtimeclass-kata.yaml` · `services/sandbox-egress/high-risk-placement.js`
- [x] DLQ Replay 운영 도구 + 런북 — [`deploy/docs/dlq-replay.md`](deploy/docs/dlq-replay.md) · `check-dlq-replay.sh` · `dlq-replay.sh` · [`services/ops/dlq-replay/`](services/ops/dlq-replay/)
- [x] 정기 PG 복구 훈련 캘린더 — [`deploy/docs/pg-pitr-drill-calendar.md`](deploy/docs/pg-pitr-drill-calendar.md) · `check-pg-pitr-drill-calendar.sh` · [`services/ops/pitr-drill/calendar.js`](services/ops/pitr-drill/calendar.js) (분기≥1 · 스택변경≤14일 · lab-1이 2026-Q4 시드)
- [~] (출시 후 후보) NATS Account 격리 설계 착수 — eric 연기 (2026-11-19)

---

## M6 — 관리 UI 1차 MVP (ops-only)

**목표**: 플랫폼 ops가 `source_meta`/`user_meta`·번들을 등록·활성화하고, resolve가 Pooler에서 동일 식별자를 읽는다. Chat UI·테넌트 admin·과금 SPA는 비범위.

**작업**

- [x] 계약·문서 봉인 — [`deploy/docs/admin-ui-mvp.md`](deploy/docs/admin-ui-mvp.md) · ARCHITECTURE §2/§6.1 · `svc-control-resolve` 관리 HTTP 경로 교체 · `control_audit` DDL
- [x] `svc-control` 관리 HTTP — tenants/sources/overlays/presign/activate/retire · 서버측 Garage sha256 · `control_audit` · Bearer ops-only · `X-Aura-Tenant-Id`
- [x] resolve Pooler SELECT — `pooler-lookup.js` + `withTenantTx` (`set_config(..., true)`)
- [x] Admin UI MVP (`services/admin-ui`) — Tenant picker · Sources · Bundle 등록 · overlays
- [x] 게이트 — `check-admin-ui-mvp.sh` + control admin/pooler selftests

**성공 기준**

- ops 등록 → activate(서버 checksum) → resolve가 `active` 동일 식별자 반환(Pooler lookup).
- 타 테넌트 GUC로 0건 · checksum 불일치 activate 거부 · UNIQUE 재등록 409 · audit+reason · 시크릿 평문 없음.

**Non-goals:** tenants/ACL 테이블 · 테넌트 admin SSO · 과금 SPA · DLQ/PITR/erase 콘솔 · Chat UI.

---

## M6.1 — Admin UI React 재설계 (ops-only)

**목표**: vanilla MVP를 React+TS+Tailwind+shadcn 스택으로 승격하고, 관리 대상 인벤토리·PG SoR·KV=Gateway-only·`GET /v1/audit`를 봉인한다.

**작업**

- [x] 계약·문서 — [`deploy/docs/admin-ui.md`](deploy/docs/admin-ui.md) · ARCHITECTURE §2/§6.1.1 · ROADMAP · AGENTS
- [x] Vite + React 19 + TS + Tailwind + shadcn + TanStack Query + Zustand + RHF/Zod SPA
- [x] `GET /v1/audit` + Audit 화면 · Sources/Bundles/Overlays parity
- [x] 게이트 — `check-admin-ui.sh` + Vitest + `npm run build`

**성공 기준**

- ops 등록 → activate → resolve 동일 · Audit 조회 · UI가 NATS/Gateway HTTP를 열지 않음 · Zod가 `runtime` in config·plaintext secrets 거부.

**Non-goals:** Phase 2 quota 본배선 · tenants/ACL · SSO · 과금 SPA · Chat · memory 정책 Admin 쓰기 · control-admin KV 직접 접속.

---

## M6.2 후보 — Admin UI 후속 (ops-only)

**목표**: Tenant SoR·Phase 2 quota 배선. 한도 정책 편집과 SSO는 분리.

**작업**

- [x] `tenant_meta` DDL + Admin HTTP/UI alias (UUID + `display_name` · RLS) — OIDC/SSO **제외**
- [x] Phase 2 quota **조회·리셋** — UI → control-admin `GET/POST /v1/quotas/…` · injectable `quotaLimiter`/`quotaRpc` (live NATS RR→Gateway 배선=후속) · 한도 숫자 편집 UI **금지**
- [x] `source_meta.function` 컬럼 분리 — custom Router 이름 · zip `entrypoint`와 CHECK로 상호 배타 · Bundles UI 분기
- [x] Tenant scaffold + Sources Download — [`scaffolds/`](scaffolds/) · `GET /v1/sources/{id}/bundle` (custom 제외)
- [~] **Quota 한도 수정** (`rate`/`burst`/`maxInflight` · 플랜 tier) — PG `tenant_plan`(후보) SoR + Gateway 로드 · **이번(M6.1/M6.2 조회·리셋) 범위 밖** · M5/후속 티켓으로 승격 시 착수
- [~] live `aura.rpc.gateway.quota` Core RR 배선 (control-admin→Gateway) — injectable 이후
- [~] Gateway payload `function` 스탬프 live 배선 (`resolve.function` → task)

**Non-goals:** OIDC/SSO · KV 직접 접속 · Admin→Gateway HTTP · 과금 SPA.

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
- 테넌트 rate/burst/inflight·플랜 tier 최종 숫자 — **M3 DESIGN**(기능은 M3 필수) · **Admin UI에서 한도 수정**은 M6.2 후보 `[~]` (조회·리셋과 분리)
- F1 테넌트 subject 샤딩 — **M3 노이지 픽스처 후**
- ~~gVisor vs Kata 최종 선택~~ — **M3 고정:** 기본=`gvisor`(`runsc`) · 고위험=`kata` ([`mcp-bundle-isolation.md`](deploy/docs/mcp-bundle-isolation.md)); 라이브 apply·실측=후속
- sync 연쇄 p95 최종(1s vs 2s) — **M0 측정**
- ~~RPO/RTO **드릴 실측으로 초안 교체**~~ — **M4 확정:** 예산 **RPO ≤ 5m · RTO ≤ 1h**(lab-1 ≈3.2s/3.1s 충족) · [`pg-pitr-drill.md`](deploy/docs/pg-pitr-drill.md). ~~CNPG/Barman 스케일 재드릴=M5~~ → **M5 캘린더** [`pg-pitr-drill-calendar.md`](deploy/docs/pg-pitr-drill-calendar.md) (cluster 드릴은 슬롯·Barman live 시)
- ~~암호화 키 KMS 제품~~ — **M4 고정:** OpenBao Transit (`openbao-transit`); 클라우드 KMS·live apply=`@eric`/M5

---

## 범위 밖 (초기)

LLM **가중치** 서빙/vLLM, Chat UI 풀스택, 헬프데스크 FSM/옴니채널, path-graph/VFS 통째 이식.  
범위 **안**: LLM Gateway, Parquet 아카이브, 샌드박스, mTLS, DLQ, PG HA, GDPR erase.
