# otel (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M4 — OTel (Function·NATS·PG) + 시크릿 마스킹 검증.  
정본: [`deploy/docs/otel-function-nats-pg.md`](../../deploy/docs/otel-function-nats-pg.md).  
마스킹: [`../control/secrets-mask.js`](../control/secrets-mask.js) (M3).

**이 문서 범위:** 스팬 attribute **allowlist** · 필수 상관 ID · Function/NATS/PG 빌더 · `maskSecrets` 재사용.  
**Non-goals:** live OTLP exporter · Collector 배포 CI · erase · PITR · M5 대시보드 · SDK auto-instrumentation 본배선.

---

## 모듈

| 파일 | 역할 |
|------|------|
| `attributes.js` | `ALLOWED_ATTR_KEYS` · `REQUIRED_CONTEXT_KEYS` · `sanitizeAttributes` · `assertSafeAttributes` |
| `spans.js` | `buildFunctionSpanAttributes` · `buildNatsSpanAttributes` · `buildPgSpanAttributes` |
| `*.selftest.js` | allowlist drop · 상관 ID 필수 · 시크릿/DSN/params 평문 없음 |

호출자는 자체 tracer에 빌더 결과만 `setAttribute`한다. PG `query_params`/`connection_string`은 빌더가 무시.

---

## Commands

```bash
node services/otel/attributes.selftest.js
node services/otel/spans.selftest.js
bash deploy/scripts/check-otel-function-nats-pg.sh
```
