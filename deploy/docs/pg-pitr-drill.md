# PG PITR 복구 드릴 #1 — RPO/RTO 실측 (M4 · §9.6)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.6.  
토폴로지 초안: [`pg-ha-pitr-topology.md`](pg-ha-pitr-topology.md) · Barman 버킷 `aura-pg`.  
코드: [`services/ops/pitr-drill/`](../../services/ops/pitr-drill/) · 게이트 [`../scripts/check-pg-pitr-drill.sh`](../scripts/check-pg-pitr-drill.sh) · lab 러너 [`../scripts/run-pg-pitr-lab-drill.sh`](../scripts/run-pg-pitr-lab-drill.sh) · restore draft [`../k8s/pg-pooler/cluster-pitr-restore.draft.yaml`](../k8s/pg-pooler/cluster-pitr-restore.draft.yaml) · smoke [`../scripts/smoke-pg-pitr-drill.sh`](../scripts/smoke-pg-pitr-drill.sh).

**이 문서 범위:** 복구 드릴 **1회** 런북 · RPO/RTO **실측 기록** · 예산 확정.  
**Non-goals:** live Multi-AZ apply · Garage `aura-pg` provision · 다른 M4 체크리스트 재오픈.  
**정기 일정:** M5 캘린더 [`pg-pitr-drill-calendar.md`](pg-pitr-drill-calendar.md) · `check-pg-pitr-drill-calendar.sh`.

---

## 예산 (M1 초안 → M4 확정)

| 지표 | 예산 | 의미 |
|------|------|------|
| **RPO** | **≤ 5분** | incident − newest **verified recovered** txn (백업 잡 시각 아님) |
| **RTO** | **≤ 1시간** | `restore_start` → `dsn_cutover_end`(Pooler DSN 전환·가용) |

lab 스케일 실측은 예산을 **충족 확인**한다. 프로덕션 데이터 볼륨으로 예산을 축소하지 않는다(스케일 재드릴=M5).

---

## 측정 정의

코드: `measureDrill` (`services/ops/pitr-drill/measure.js`).

| 필드 | 정의 |
|------|------|
| `incident_at` | 장애/복구 결정 시각(UTC) |
| `newest_verified_at` | 복구 DB에서 검증한 최신 업무 행 시각 |
| `rpo_ms` | `incident_at − newest_verified_at` |
| `phases.restore_start`…`dsn_cutover_end` | 복원→리플레이→검증→DSN 전환 |
| `rto_ms` | `dsn_cutover_end − restore_start` |

프로비저닝(워웜 풀 없음)은 기록 가능하나 headline RTO에는 **restore→cutover**만 포함한다(워웜 타깃이 없으면 프로비저닝을 별도 란에 남김).

---

## 클러스터 런북 (CNPG · Barman Cloud)

1. 장애 시나리오·owner 기록. 복구는 **신규 Cluster** + `bootstrap.recovery` (인플레이스 overwrite 금지).
2. `aura-pg` object-store에서 base + WAL 확인(`barmanObjectStore.destinationPath`).
3. `recoveryTarget.targetTime`(또는 xid/lsn) 선택 — 목표 시각 **이후** 커밋은 손실(RPO).
4. 복구 Cluster Ready → 스키마/확장/마커 행 검증 → **Pooler DSN**만 전환(앱은 `-rw`/`-ro` 직접 연결 금지).
5. `drill-N.record.json` 작성 후 `measureDrill`로 예산 평가 · 이 문서 표 갱신.

참고: [CNPG Recovery](https://cloudnative-pg.io/documentation/1.23/recovery/) · [Barman restore](https://docs.pgbarman.org/release/3.12.0/user_guide/recovery.html).

---

## Drill #1 실측 (lab)

| 항목 | 값 |
|------|-----|
| `drill_id` | `lab-1` |
| `mode` | `lab` (Docker Postgres 16 · WAL `archive_command` — CNPG Barman 경로 대용) |
| ticket | `996b3f7e` |
| 레코드 | [`drill-1.record.json`](../../services/ops/pitr-drill/drill-1.record.json) |
| **RPO** | **3249 ms** (≈ 3.2s) → ≤ 5m **PASS** |
| **RTO** | **3095 ms** (≈ 3.1s) → ≤ 1h **PASS** |
| 검증 | `pre_incident` 행 존재 · `lost_after_incident` 부재 |

재현(선택, Docker 필요):

```bash
bash deploy/scripts/run-pg-pitr-lab-drill.sh
node services/ops/pitr-drill/measure.selftest.js
bash deploy/scripts/check-pg-pitr-drill.sh
```

CI 게이트는 **커밋된 레코드 + measure selftest**만 요구한다(live Docker 비필수).

---

## 결정 로그

| 날짜 | 결정 |
|------|------|
| 2026-11-19 | M4 drill #1(lab): measured RPO≈3.2s · RTO≈3.1s → **RPO ≤ 5m · RTO ≤ 1h 확정**(초안 유지·충족). 프로덕션 CNPG/Barman 재드릴·스케일 → M5 캘린더. |
| 2026-11-19 | lab-1을 **2026-Q4** 정기 슬롯 시드로 등록 — [`pg-pitr-drill-calendar.md`](pg-pitr-drill-calendar.md). |
