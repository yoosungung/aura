# 정기 PG 복구 훈련 캘린더 (M5 · §9.6)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.6 **훈련** — 분기 1회 이상.  
드릴 런북·측정: [`pg-pitr-drill.md`](pg-pitr-drill.md) · 토폴로지 [`pg-ha-pitr-topology.md`](pg-ha-pitr-topology.md).  
코드: [`services/ops/pitr-drill/calendar.js`](../../services/ops/pitr-drill/calendar.js) · 시드 [`calendar.json`](../../services/ops/pitr-drill/calendar.json) · 게이트 [`../scripts/check-pg-pitr-drill-calendar.sh`](../scripts/check-pg-pitr-drill-calendar.sh).

**이 문서 범위:** 정기·스택변경 후 복구 훈련 **일정 정책** · 준수 평가 · 기록 절차.  
**Non-goals:** 캘린더 UI · 자동 cron이 복구 Cluster를 apply · Garage `aura-pg` live provision · M4 lab-1 재오픈.

---

## 정책 (고정)

| 항목 | 값 |
|------|-----|
| **최소 cadence** | **quarterly** (≥1 **pass** 드릴 / UTC 분기) |
| **연간 최소** | **4** |
| **소프트 due_by** | 분기 **마지막 달 1일** UTC (Q1→3/1 · Q2→6/1 · Q3→9/1 · Q4→12/1) |
| **모드** | 선호=`cluster`(CNPG+Barman) · 허용=`lab`(Docker WAL) until Barman live |
| **예산** | RPO ≤ 5m · RTO ≤ 1h ([`measureDrill`](../../services/ops/pitr-drill/measure.js)) |
| **스택 변경 후** | backup/plugin/ObjectStore/recovery 스택 변경일부터 **≤ 14일** 내 추가 드릴 |

분기 초·due_by 이전·미실시 = **pending**(캘린더 `pass`). due_by 이후·미실시 = **overdue**.

---

## 트리거

| trigger | 언제 |
|---------|------|
| `scheduled` | 분기 정기 슬롯 |
| `stack_change` | Barman/CNPG recovery/ObjectStore/`ScheduledBackup` 변경 후 |
| `incident_followup` | 실장애 복구 후 사후 검증(선택) |

---

## 운영 절차

1. **슬롯 확인** — `plannedSlots(year)` 또는 이 문서 표 · `calendar.json` history.
2. **드릴 실행** — [`pg-pitr-drill.md`](pg-pitr-drill.md) 런북 (`lab` 또는 `cluster` restore draft).
3. **측정** — `measureDrill` PASS → `drill-N.record.json` 커밋(해당 시).
4. **캘린더 기록** — `calendar.json` `history[]`에 `{ drill_id, completed_at, mode, trigger, pass: true }` append.
5. **스택 변경** — 변경일 `stack_change_at` 기입; 14일 창 안 follow-up 완료 후 null로 클리어(또는 다음 변경까지 유지하지 않음).
6. **게이트** — `bash deploy/scripts/check-pg-pitr-drill-calendar.sh`.

격리: 복구 Cluster는 **스크래치 NS**/별도 이름. 프로덕션 PVC·DSN 공유 금지. 종료 후 tear-down.

---

## 2026 시드

| quarter | due_by (UTC) | 상태 (시드 시점) |
|---------|--------------|------------------|
| 2026-Q1 | 2026-03-01 | 미실시(레포 시작 전 — 소급 강제 없음) |
| 2026-Q2 | 2026-06-01 | 미실시(소급 강제 없음) |
| 2026-Q3 | 2026-09-01 | 미실시(소급 강제 없음) |
| 2026-Q4 | 2026-12-01 | **lab-1** PASS (`996b3f7e`, 2026-11-19) |

소급: 캘린더 도입 전 분기는 history 없이도 게이트가 **현재 분기**만 평가한다. 과거 공백을 CI에서 실패로 올리지 않는다.

---

## Commands

```bash
node services/ops/pitr-drill/calendar.selftest.js
bash deploy/scripts/check-pg-pitr-drill-calendar.sh
# 기존 드릴 게이트도 유지
bash deploy/scripts/check-pg-pitr-drill.sh
```

---

## 결정 로그

| 날짜 | 결정 |
|------|------|
| 2026-11-19 | M5: 정기 훈련 = **분기≥1** + 스택변경 **≤14일** · due_by=분기 말월 1일 · lab 허용(Barman 전) · UI/자동 apply 비채택. |
