# services/ops — 운영 드릴·측정 헬퍼

**범위:** 플랫폼 운영 검증용 소형 유틸(현재: PG PITR 드릴 측정).  
**Non-goals:** 라이브 CNPG apply · Barman 자격증명 · M5 훈련 캘린더 UI.

## PITR drill

| 파일 | 역할 |
|------|------|
| `pitr-drill/measure.js` | RPO/RTO 계산·예산(≤5m/≤1h) 판정 |
| `pitr-drill/measure.selftest.js` | 단위 + committed `drill-1.record.json` PASS |
| `pitr-drill/drill-1.record.json` | lab-1 실측 기록 (커밋) |

절차·클러스터 draft: [`deploy/docs/pg-pitr-drill.md`](../../deploy/docs/pg-pitr-drill.md).

## Commands

```bash
node services/ops/pitr-drill/measure.selftest.js
bash deploy/scripts/run-pg-pitr-lab-drill.sh   # Docker Postgres WAL PITR → record
bash deploy/scripts/check-pg-pitr-drill.sh
```
