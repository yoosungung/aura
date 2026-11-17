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
| (M1) | 활성 임베딩 실값 + BM25 + Pooler 제품 + iterative_scan + **PG HA/RPO/RTO 초안** | M1에서 고정 |
| (M0) | async 콜드 p95 + **sync Warm 홉/연쇄 p95** 기입 | M0 스모크 후 |

---

## M0 — Fission 부트스트랩 (async MQT + sync RPC 이원화)

**목표**: Fission·KEDA·NATS를 올리고, ARCHITECTURE §4 두 계급이 **분리 배포**로 스모크된다. 프레임워크 재선택 스파이크가 아니다.

**작업**

- [x] K8s에 NATS JetStream, KEDA, Fission 설치 (`deploy/SETUP.md` · `deploy/scripts/install-runtime.sh`)
- [ ] 스트림 `AURA_TASKS` / `AURA_EVENTS` / **`AURA_DLQ`** 사전 생성
- [ ] **분리 배포**: async MQT Function(scale-to-zero 가능)과 sync Warm Function(`aura.rpc.*`, minReplicas≥2)을 **별 매니페스트/별 ScaledObject**로 둔다 — 동일 Deployment에 0과 ≥2를 섞지 않음
- [ ] **Async**: 샘플 Function + MQT — `aura.tasks.smoke` → echo → `resptopic` / `errortopic`
- [ ] **Async poison**: 파싱 불가/고의 실패 메시지로 **MaxDeliver 초과** → `errortopic` 및/또는 **`AURA_DLQ`** 적재 확인
- [ ] **Sync**: 샘플 RPC — `aura.rpc.smoke`, **`minReplicas >= 2`**, JetStream MQT·lag scaler **미연결**
- [ ] pull consumer·RPC queue-group·DLQ subject·분리 배포 이름 문서화
- [ ] (권장) PG + Pooler 스모크 계획 — 본문은 M1
- [ ] **DLQ 적재 경로 확정**(아래 유의사항) → 결정 로그 1행

**구현 유의사항 (착수 시 확인)**

1. **Sync RPC Executor** — Fission 기본 `poolmgr`는 HTTP specialize 전까지 NATS에 안 붙는다. `aura.rpc.*`(V0.1·V0.2)는 기동 즉시 Core queue-group subscribe가 필요하므로 **`newdeploy`(minScale ≥ 2)** 또는 ARCHITECTURE §4.3의 **동일 이미지 명시 Deployment**로 띄운다. poolmgr+scale-to-zero로 sync를 검증하지 않는다.
2. **MaxDeliver → `AURA_DLQ`는 JetStream 자동 이관이 아님** — 초과 시 재전달만 중단되고 `$JS.EVENT.ADVISORY…`가 난다. V0.3에서 **택일** 후 결정 로그에 기입: ① 함수/미들웨어가 delivery count ≥ MaxDeliver를 보고 `AURA_DLQ` 발행 후 `Term()` · ② Advisory 구독기가 DLQ로 넘김. 둘 다 구현하지 말고 하나를 고정한다.

**검증 체크리스트 (권고 반영)**

| # | 검증 | 합격 |
|---|------|------|
| V0.1 | async MQT와 sync Warm Function **분리 배포** | 매니페스트/네임스페이스 라벨로 구분; sync에 JetStream ScaledObject 없음 |
| V0.2 | sync **No Responders 방지** | Warm 상태에서 RR 성공; sync를 0으로 내리면 즉시 실패(회귀) |
| V0.3 | MaxDeliver 초과 격리 | 워커 무한 재시도 없음; `errortopic` 및/또는 `AURA_DLQ`에 잔존 |

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

- [ ] BM25 구현체 결정 → 결정 로그 기입
- [ ] **PgBouncer(또는 CNPG Pooler) Transaction Pooling** 설치; 앱 DSN = pooler only → 결정 로그에 제품명 기입
- [ ] **통합 테스트**: Pooler + `SELECT set_config('app.tenant_id', $1, true)` + RLS — 커넥션 재사용 후 타 테넌트 행 미노출
- [ ] PG **Multi-AZ / PITR** 토폴로지 + RPO/RTO 초안 (recall Read Replica 계획)
- [ ] `memory_items` **LIST(memory_type)** + short_term/episodic **월 RANGE** 파티션 + RLS
- [ ] `memory_audit` **월 RANGE** 파티션
- [ ] **short_term 만료 정리 정책** 문서화: 핫 일수·월 파티션 DROP 주기·담당 태스크(`aura.tasks.memory.ttl`) — DESIGN에 수치 고정
- [ ] `memory_nodes` / `memory_edges` 마이그레이션 + RLS
- [ ] edges **`idx_memory_edges_out` / `idx_memory_edges_in`** (partial `valid_until IS NULL`); 순회 한도 DESIGN(§6.2.4)
- [ ] **`memory_embeddings` 차원/파티션 DDL 확정**: LIST(`model_key`) + 파티션별 `halfvec(N)` HNSW; **모델 세대 교체**(새 파티션 ATTACH → 전환 → 구형 DETACH) 절차를 DESIGN/런북에 고정
- [ ] **short_term embed 거부** 가드; pgvector **≥ 0.8**; `ef_search` / `iterative_scan` DESIGN
- [ ] **멀티테넌트 HNSW 픽스처**: 대형 A + 소형 B — ON≥1 / OFF 대조 회귀; 실패 시 T1/T2
- [ ] 활성 `AURA_EMBEDDING_MODEL` / `version` / `dims` → 결정 로그; TTL 초안(14일/24개월/12개월)
- [ ] `services/memory/DESIGN.md` + store MQT — 매 트랜잭션 `set_config(..., true)`
- [ ] (스모크) 무차원 HNSW 실패; short_term→embed 거부

**검증 체크리스트 (권고 반영)**

| # | 검증 | 합격 |
|---|------|------|
| V1.1 | PgBouncer transaction pooling + RLS `set_config(..., true)` | 풀 재사용 후 테넌트 오염 없음; `set_config(..., false)` 경로 없음 |
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

- [ ] `memory_capture` Function (PG 금지, MQT) → `aura.events.memory.candidates`
- [ ] embed Function (MQT) — **short_term 스킵**; episodic/long_term/semantic만 HNSW/BM25
- [ ] **recall RPC Function** 별도 배포: `minReplicas >= 2`, Core queue-group, MQT 없음
- [ ] recall: short_term=최근순; 나머지 hybrid RRF (+ graph stub); iterative_scan + tenant WHERE
- [ ] Agent 주입 계약(프롬프트 슬롯·토큰 예산)
- [ ] **Object Store 제품 확정**(Garage/S3/NCP 등) → 결정 로그; `content_ref` 스키마·권한
- [ ] **고아 객체 GC 설계**: 이벤트/메모리 TTL(예: 90일) 후 미참조 `content_ref` 삭제 배치·멱등 키 — DESIGN에 알고리즘 고정(구현은 M4와 맞춰도 됨)

**검증 체크리스트**

| # | 검증 | 합격 |
|---|------|------|
| V2.1 | Object Store 제품·버킷/경로 | 결정 로그에 제품명; 256KB 초과 페이로드가 `content_ref`만 사용 |
| V2.2 | 90일(또는 정책일) 고아 GC 설계 | DESIGN에 GC 쿼리/태스크·안전장치(참조 존재 시 스킵) 명시 |

**성공 기준**

- capture DB 쓰기 없음; recall에 JetStream ScaledObject 없음; 유형별 예산 동작.
- V2.1–V2.2 합격.

---

## M3 — `agent_invoke` / `mcp_invoke` + 스트림 + Fair Queue + 샌드박스

**목표**: Agent 턴 + **`aura.stream.*` 토큰 스트리밍** + **테넌트 Rate Limit** + 외부/커스텀 MCP **Egress/샌드박스** 정의·검증.

**작업**

- [ ] `svc-control` 최소 resolve API/스키마 (`source_meta`/`user_meta`)
- [ ] `agent_invoke` MQT — recall/mcp/resolve RPC + **`aura.stream.<run_id>` 토큰/툴 프레임** 설계·구현
- [ ] Gateway: `run_id` 발급; SSE/WS 브리지 + principal 인가
- [ ] Gateway: **테넌트별 Rate Limiting** — Token Bucket + max_inflight(§2.2); NATS KV; 429; 노이지 픽스처
- [ ] done/error 시 inflight 감산; 우회 시 `agent_invoke` 재확인
- [ ] 프레임 계약 확정: `run.started` / `token` / `tool.*` / `run.completed` + events done
- [ ] `mcp_invoke` **이원화**: task(MQT) + rpc(`aura.rpc.mcp.tool`, minReplicas ≥ 2)
- [ ] `aura.rpc.control.resolve` 브리지 minReplicas ≥ 2
- [ ] 체크포인트 예외 테이블 DDL (§6)
- [ ] 외부 MCP Streamable HTTP 어댑터
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

- 활성 임베딩 모델·version·dims(N) 실값 — **M1** (레이아웃 방안 B·halfvec는 결정됨)
- Pooler 제품(PgBouncer vs CNPG Pooler) — **M1** (Pooler 필수·transaction·GUC `is_local`은 결정됨)
- BM25 구현체 (`tsvector` vs ParadeDB/`pg_search`) — **M1**
- iterative_scan만으로 충분한지 vs T1/T2 승격 — **M1 픽스처 결과**
- 그래프 `per_hop_limit` / `supernode_degree_cap` 최종 수치 — **M1 DESIGN 초안 → M4 부하 테스트**
- async 콜드스타트 p95 확정 수치 — **M0 측정 후**
- sync RPC 상한 스케일(HPA 메트릭: CPU vs RPS) — M2/M3 직전
- Object store **아카이브 Parquet 경로가 번들/`content_ref`와 버킷 공유인지** — **M2 제품 확정 시** 같이 기록 (GC 설계는 M2, 아카이브 구현은 M4)
- short_term/episodic/audit 핫 일수 운영 튜닝 — M1 정책 수립 → M4 부하 후 조정
- NATS account 격리 — **출시 후**
- 테넌트 rate/burst/inflight·플랜 tier 최종 숫자 — **M3 DESIGN**(기능은 M3 필수)
- F1 테넌트 subject 샤딩 — **M3 노이지 픽스처 후**
- gVisor vs Kata 최종 선택 — **M3 V3.3**
- sync 연쇄 p95 최종(1s vs 2s) — **M0 측정**
- RPO/RTO 확정 — **M1**
- 암호화 키 KMS 제품 — **M4 erase 직전**

---

## 범위 밖 (초기)

LLM **가중치** 서빙/vLLM, Chat UI 풀스택, 헬프데스크 FSM/옴니채널, path-graph/VFS 통째 이식.  
범위 **안**: LLM Gateway, Parquet 아카이브, 샌드박스, mTLS, DLQ, PG HA, GDPR erase.
