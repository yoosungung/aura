# PG Multi-AZ / PITR 토폴로지 + RPO/RTO 초안 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3 · §2.1 · **§9.6**.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (초안) · M4 (PITR 복구 드릴 실측).  
출발점: [`../k8s/pg-pooler/cluster.yaml`](../k8s/pg-pooler/cluster.yaml) (`instances: 1`, Pooler+RLS 스모크).

**이 문서 범위:** Multi-AZ 토폴로지 초안 · PITR(연속 WAL+base) · **RPO/RTO 수치 초안** · recall Read Replica 계획 1단락.  
**Non-goals:** RLS 재작업 · `memory_*` DDL · `services/memory` 본문 · 비용/리전 실값 발명 · 라이브 Multi-AZ apply(클러스터·버킷·시크릿은 후속 apply 티켓).

**제품:** CloudNativePG `Cluster` + 기존 `Pooler`(transaction). HA도 동일 operator — standalone Patroni/별도 Barman 서버 비채택.

---

## 현재 → 목표

| 축 | 현재 (V1.1 스모크) | 목표 토폴로지 (초안) |
|----|-------------------|---------------------|
| instances | `1` | **`3`** (primary + 2 standby) |
| AZ 배치 | 미지정 | `affinity.enablePodAntiAffinity: true` + `topologyKey: topology.kubernetes.io/zone` |
| 앱 DSN | `aura-pg-pooler` only | **불변** — PG `-rw`/`-r`/`-ro`·Pod IP 직접 연결 금지 |
| 백업 | 없음 | `spec.backup.barmanObjectStore` + WAL archive + ScheduledBackup |
| 적용물 | `deploy/k8s/pg-pooler` kustomization | 라이브 HA는 별도 apply; 참고 매니페스트 [`../k8s/pg-pooler/cluster-ha.draft.yaml`](../k8s/pg-pooler/cluster-ha.draft.yaml) (**kustomization 미포함**) |

단일 AZ·단일 PVC는 §9.6 “디스크 1장” 단일 장애점이므로 **프로덕션 목표에서 금지**. 로컬/CI 스모크는 `instances: 1` 유지 가능.

---

## Multi-AZ (CNPG)

1. **instances=3** — 존 단위 장애 시 자동 페일오버(CNPG). 쿼럼·동기 복제 파라미터는 apply 시 DESIGN/런북에 고정(초안: 기본 async streaming + `primaryUpdateStrategy: unsupervised`).
2. **존 안티어피니티** — `topology.kubernetes.io/zone`. 존 레이블 없는 클러스터(랩톱 kind 등)는 hostname 키로 폴백하되, **프로덕션 게이트는 zone 키 필수**.
3. **스토리지** — 인스턴스별 PVC; StorageClass는 AZ-aware(또는 존별 볼륨). 클래스 실명은 클러스터 소유자(`@eric`/TA) 확정 — 이 초안에 벤더명 기입 안 함.
4. **Pooler** — 기존 `aura-pg-pooler`는 **RW**(store/`svc-control` 쓰기). 스케일은 PG instances와 독립(PgBouncer Deployment replicas).

---

## PITR

| 항목 | 초안 |
|------|------|
| 경로 | CNPG **Barman Cloud** (`barmanObjectStore`): base backup tarball + **연속 WAL archive** |
| 스케줄 | ScheduledBackup 일 1회 이상(예: `0 0 0 * * *` UTC) + WAL 상시 |
| 보존 | `retentionPolicy: 30d` (초안; 컴플라이언스 연장 시 ROADMAP만 갱신) |
| 복구 | 신규 `Cluster` + `bootstrap.recovery.source` + `recoveryTarget.targetTime` (inplace 인플레이스 overwrite 금지) |
| 시크릿 | object-store 자격증명 Secret — git에 값 금지; draft YAML은 키 이름만 |

M4 작업 항목 «PG 복구 드릴 1회(PITR)»이 이 경로의 **실측** 게이트다. 초안 수치 ≠ 드릴 합격.

---

## RPO / RTO 초안 (M1 고정 · 드릴 전)

ARCHITECTURE §9.6과 동일 수치를 **M1 초안으로 고정**한다. 비용·리전·스토리지 실측으로 바꿀 때는 결정 로그 1행 + 이 문서·§9.6을 같이 고친다.

| 지표 | 초안 | 의미 |
|------|------|------|
| **RPO** | **≤ 5분** | 연속 WAL archive 전제. object-store 장애·archive lag가 5분을 넘기면 알람(후속 모니터). |
| **RTO** | **≤ 1시간** | (a) AZ/파드 손실 → CNPG 페일오버(분 단위 목표, 1h 예산 내) (b) 논리 손상·PITR 복구 → 신규 클러스터 기동·DNS/DSN 전환 포함 **≤ 1h** 목표. |

확정(드릴 실측으로 초안을 교체)은 M4. «미결정 — RPO/RTO 확정»은 **초안 고정 / 실측 대기**로 해석한다.

---

## recall Read Replica 계획

`svc-memory` **store·임베딩·그래프 쓰기**는 계속 **RW Pooler**(`aura-pg-pooler` → primary)만 쓴다. **recall**(및 읽기 비중 큰 sync 경로)은 CNPG `Pooler` **`type: ro`**(가칭 `aura-pg-pooler-ro`)를 추가해 standby로 오프로드한다 — 앱은 여전히 Pooler DNS만 보고 `-ro` Service에 직접 붙지 않는다. replica lag가 recall 신선도 SLO를 깨면 (1) sync 임계 질의만 RW Pooler로 폴백하거나 (2) instances/동기화 파라미터를 조정하며, 별도 외부 Read Replica 제품은 도입하지 않는다.

---

## Apply 순서 (후속 · 이 티켓 비범위)

1. zone 레이블·StorageClass·object-store 버킷/시크릿 준비.
2. `cluster-ha.draft.yaml`을 실환경 값으로 채운 뒤 `instances`/`backup` 적용(또는 동등 패치). 스모크용 `instances: 1` 매니페스트와 **경로를 섞지 않음**.
3. `aura-pg-pooler-ro` 추가 → recall DSN만 전환(store DSN 불변).
4. `check-pg-pooler.sh` / `smoke-pg-pooler.sh` 회귀(RW) + RO 스모크(후속).
5. M4: PITR 드릴 → RPO/RTO 실측을 ROADMAP에 기입.

---

## 관련 링크

- Pooler+RLS: [`pg-pooler-smoke-plan.md`](pg-pooler-smoke-plan.md) · [`../k8s/pg-pooler`](../k8s/pg-pooler/)
- CNPG backup/PITR: [Backup on object stores](https://cloudnative-pg.io/documentation/1.23/backup_barmanobjectstore/) · [Recovery](https://cloudnative-pg.io/documentation/1.23/recovery/)
- 티켓: `f320c964-2f59-43af-a5db-484f2713b691`
