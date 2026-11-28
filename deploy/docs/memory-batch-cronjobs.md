# Memory batch CronJobs — 스케줄 계획

계약 현행: [ARCHITECTURE.md](../../ARCHITECTURE.md) §3.2 · §6.2.2 · [ROADMAP.md](../../ROADMAP.md) M4.  
관련: [`memory-ttl-policy.md`](memory-ttl-policy.md) · [`memory-ttl-drop.md`](memory-ttl-drop.md) · [`object-store-orphan-gc.md`](object-store-orphan-gc.md) · [`memory-archive.md`](memory-archive.md) · [`memory-consolidate-promotion.md`](memory-consolidate-promotion.md).  
캡처 통합과 별 트랙: [`memory-capture-inline-pipeline.md`](memory-capture-inline-pipeline.md).

**이 문서 범위:** consolidate / TTL / archive / object_gc **배치 트리거**를 **Kubernetes CronJob**으로 고정하는 **계획만**.  
**Non-goals:** 본 문서에서 CronJob yaml·publish 스크립트 커밋 · handler 본구현 · NATS JetStream native schedule(`Nats-Schedule`) · NATS KV 타이머.

**결정 (2026-11-28 · 사용자: “크론 잡으로 하자.”):**  
배치 발행기 = **Kubernetes `CronJob`**. NATS 단독 스케줄러·in-cluster custom scheduler **비채택**. CronJob은 **handler를 실행하지 않고** JetStream subject에 envelope **publish만** 한다. 처리는 기존 ns `aura` memory **Deployment** durable consumer가 담당.

**결정 (2026-11-28 · 이미지 이름 확정):**  

| 이미지 | 역할 |
|--------|------|
| **`aura/memory-capture`** | capture 핸들러(+ inline store/embed)만 |
| **`aura/memory-recall`** | recall sync |
| **`aura/memory-batch`** | consolidate · ttl · archive · object_gc + CronJob publish |

캡처 이미지에 배치 핸들러를 넣지 않는다. CronJob·배치 Deployment는 **`aura/memory-batch`만** 사용.

---

## 1. 목표 모양

```
CronJob (UTC 일 1회)
    │  nats pub --js  (또는 동등 클라이언트)
    ▼
aura.tasks.memory.{consolidate|ttl|archive|object_gc}
    │  AURA_TASKS · durable 기존 유지
    ▼
aura-memory-{consolidate|ttl|archive|object-gc} Deployment
    │  handler → Pooler / Object Store
    ▼
aura.events.memory.*  (기존 resp/error subject)
```

| CronJob (계획 이름) | publish subject | 소비 Deployment |
|---------------------|-----------------|-----------------|
| `aura-memory-consolidate-cron` | `aura.tasks.memory.consolidate` | `aura-memory-consolidate` |
| `aura-memory-ttl-cron` | `aura.tasks.memory.ttl` | `aura-memory-ttl` |
| `aura-memory-archive-cron` | `aura.tasks.memory.archive` | `aura-memory-archive` |
| `aura-memory-object-gc-cron` | `aura.tasks.memory.object_gc` | `aura-memory-object-gc` |

---

## 2. 스케줄·정책 (채택)

| 항목 | 값 |
|------|-----|
| 주기 | **일 1회** · **UTC** (기존 TTL/object_gc 수치와 정합) |
| cron 표현 | `0 0 * * *` (자정 UTC; 랩에서 시각 조정 시 문서·매니페스트 동시 갱신) |
| `concurrencyPolicy` | **`Forbid`** — 이전 Job 미종료 시 스킵 |
| `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` | 예: `1` / `3` (랩 최소) |
| 네임스페이스 | **`aura`** |
| 역할 분리 | CronJob = **publish only** · Deployment = **handler** · Fission MQT 아님 |
| 비채택 | NATS KV 스케줄 · JetStream `Nats-Schedule` 헤더 스케줄러 · CronJob이 PG/S3 직접 조작 |

멱등: envelope `id`는 일자·테넌트 기반 기존 규칙 유지  
(예: object_gc `object-gc:{tenant}:{yyyy-mm-dd}` — [`object-store-orphan-gc.md`](object-store-orphan-gc.md)).  
재시도는 JetStream MaxDeliver / durable; CronJob 재실행은 **같은 일자 멱등 id**로 중복 안전.

---

## 3. 매니페스트 계획 (`deploy/k8s` · **미착수**)

구현 착수 시 추가(본 계획은 파일만 명시 · **지금 커밋하지 않음**):

| 경로 | 내용 |
|------|------|
| `deploy/k8s/memory-consolidate/cronjob.yaml` | consolidate publish CronJob |
| `deploy/k8s/memory-ttl/cronjob.yaml` | ttl publish CronJob |
| `deploy/k8s/memory-archive/cronjob.yaml` | archive publish CronJob |
| `deploy/k8s/memory-object-gc/cronjob.yaml` | object_gc publish CronJob |
| 각 디렉터리 `kustomization.yaml` | 기존 Deployment/Service에 CronJob 리소스 추가 |
| (선택) `deploy/k8s/memory-batch-cron/` | 공통 ConfigMap·ServiceAccount·nats CLI 이미지 한곳 묶음 — 중복 줄일 때만 |

### 이미지 분리 (채택)

| 이미지 | 포함 | 사용처 |
|--------|------|--------|
| **`aura/memory-capture`** | **capture만** (+ inline store/embed · Gateway client) | `aura-memory-capture` Deployment |
| **`aura/memory-recall`** | recall | `aura-memory-recall` Deployment |
| **`aura/memory-batch`** | consolidate · ttl · archive · object_gc + CronJob **publish 엔트리** | 네 배치 Deployment · 네 CronJob |
| (비채택) | 캡처 이미지에 배치 네 핸들러 동봉 · CronJob이 `aura/memory-capture` 사용 | — |

Job 컨테이너 요건(계획):

- NATS 주소·인증: 기존 제품 Secret/ConfigMap 재사용(mTLS면 동일 마운트).
- 이미지: **`aura/memory-batch`** (publish 엔트리). `natsio/nats-box` 단독·캡처 이미지 **비사용**.
- Deployment 워커도 **동일 `aura/memory-batch`** + `AURA_HANDLER` (또는 동등)로 네 핸들러 선택.
- 명령(CronJob): JetStream publish 1회(또는 테넌트 루프는 후속 DESIGN — 1차=단일 envelope / `tenant_id` 정책은 구현 PR에서 고정).
- `restartPolicy: OnFailure` · 짧은 `activeDeadlineSeconds`.

`apply-product.sh` / `check-*.sh`: CronJob 존재·`schedule`·최근 Job 성공(랩) · 배치 이미지≠캡처 이미지 게이트 추가(착수 PR).

---

## 4. 단계 (구현 시)

| Phase | 내용 | 검증 |
|-------|------|------|
| **C0** | 본 계획·ROADMAP 결정 로그 · ARCHITECTURE 미변경 | 리뷰 |
| **C1** | 네 CronJob 매니페스트 + kustomization · 로컬 apply | `kubectl -n aura get cronjob` 4개 |
| **C2** | 수동 `kubectl create job --from=cronjob/…` → durable 소비·이벤트 | 기존 check/smoke 1건씩 |
| **C3** | `memory-ttl-drop` / orphan-gc 문서의 “스케줄러” 문구 → CronJob 명시 · ARCHITECTURE §6.2.2 한 줄 | 문서 게이트 |
| **C4** | (선택) 테넌트 일괄 publish·파티션 목록 수집을 CronJob 앞단 스크립트로 — handler 계약 불변 | E2E |

권장: **C1→C2→C3**. capture inline pipeline(P0–P5)과 **병렬 가능** · 의존 없음.

---

## 5. 롤백

1. CronJob `suspend: true` 또는 매니페스트 삭제 — Deployment consumer는 유지.  
2. 수동 `nats pub`로 동일 subject 재발행 가능(기존 스모크 경로).  
3. NATS schedule로 되돌리지 않음(비채택 유지).

---

## 6. 성공 기준

- [x] 스케줄 정본 = **K8s CronJob** · UTC 일 1회 · 네 subject publish
- [x] `deploy/k8s/memory-{consolidate,ttl,archive,object-gc}/`에 CronJob(+kustomize) 존재
- [x] CronJob = publish only (`batch-cron-publish.js`)
- [x] 이미지 `aura/memory-batch` on CronJob·배치 Deployment
- [x] ROADMAP · ARCHITECTURE §5 CronJob 명시
- [x] 일일 payload 빌더 (`batch-payload.js`) — TTL/archive 콜드 월 파티션 · object_gc 멱등 id · consolidate session_boundary

---

## 관련 경로 (구현 시)

- `deploy/k8s/memory-consolidate/` · `memory-ttl/` · `memory-archive/` · `memory-object-gc/`
- `services/memory bins`
- `crates/aura-js-worker + aura-memory-batch-cron`
