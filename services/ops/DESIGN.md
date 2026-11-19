# services/ops — 운영 드릴·측정 헬퍼

**범위:** 플랫폼 운영 검증용 소형 유틸(PG PITR 드릴 측정 · DLQ Replay 플래너).  
**Non-goals:** 라이브 CNPG apply · Barman 자격증명 · M5 훈련 캘린더 UI · Advisory DLQ 이관 · 자동 replay 루프.

## PITR drill

| 파일 | 역할 |
|------|------|
| `pitr-drill/measure.js` | RPO/RTO 계산·예산(≤5m/≤1h) 판정 |
| `pitr-drill/measure.selftest.js` | 단위 + committed `drill-1.record.json` PASS |
| `pitr-drill/drill-1.record.json` | lab-1 실측 기록 (커밋) |

절차·클러스터 draft: [`deploy/docs/pg-pitr-drill.md`](../../deploy/docs/pg-pitr-drill.md).

## DLQ Replay

| 파일 | 역할 |
|------|------|
| `dlq-replay/replay.js` | Term envelope parse · dry-run/confirm plan · `aura.dlq.*` 거부 |
| `dlq-replay/replay.selftest.js` | 오프라인 단위 |

런북·CLI: [`deploy/docs/dlq-replay.md`](../../deploy/docs/dlq-replay.md) · `deploy/scripts/dlq-replay.sh`.

## Commands

```bash
node services/ops/pitr-drill/measure.selftest.js
bash deploy/scripts/run-pg-pitr-lab-drill.sh   # Docker Postgres WAL PITR → record
bash deploy/scripts/check-pg-pitr-drill.sh
node services/ops/dlq-replay/replay.selftest.js
bash deploy/scripts/check-dlq-replay.sh
```
