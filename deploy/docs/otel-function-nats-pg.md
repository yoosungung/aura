# OTel (Function · NATS · PG) + 시크릿 마스킹 (M4 · §9.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §9.2 (로그/트레이스 마스킹 · OTel attribute 허용 목록).  
내부: [`../../services/otel/DESIGN.md`](../../services/otel/DESIGN.md).  
M3 마스킹 재사용: [`nats-mtls-secrets.md`](nats-mtls-secrets.md) · `services/control/secrets-mask.js`.

**이 문서 범위:** Function · NATS · PG 스팬에 **`aura.tenant_id` / `aura.session_id` / `aura.run_id`** 필수 · attribute **allowlist** · `maskSecrets` 재사용으로 시크릿 평문 금지.  
**Non-goals:** live full-cluster Collector/OTLP exporter CI 필수 · erase · PITR · M5 대시보드 · auto-instrumentation SDK 본배선 · query parameter / DSN attribute.

---

## 상관 ID (M4 성공 기준)

모든 Aura 앱 스팬(Function · NATS · PG)은 다음 키를 **비어 있지 않게** 가진다.

| key | 의미 |
|-----|------|
| `aura.tenant_id` | 테넌트 |
| `aura.session_id` | 세션 |
| `aura.run_id` | 런(UUIDv7 등) |

누락 시 `assertSafeAttributes` → `missing_context:<key>`.

---

## Attribute allowlist

허용 키만 export. 그 외(`secrets` · `authorization` · `api_key` · `password` · `db.query.parameter.*` · `db.connection_string` · 임의 키)는 **드롭** 또는 `disallowed_attr` 거부.

| 영역 | 허용 예 |
|------|---------|
| 상관 | `aura.tenant_id` · `aura.session_id` · `aura.run_id` |
| Function | `faas.name` · `aura.function.name` · `aura.rpc.subject` |
| NATS | `messaging.system.name`=`nats` · `messaging.operation.name` · `messaging.destination.name` |
| PG | `db.system.name`=`postgresql` · `db.operation.name` · `db.query.summary` · (선택) parameterized `db.query.text` |
| 공통 | `server.address` · `server.port` · `error.type` |

빌더: `buildFunctionSpanAttributes` · `buildNatsSpanAttributes` · `buildPgSpanAttributes` (`services/otel/spans.js`).  
PG는 `query_params` / `connection_string`을 **무시**한다 — DSN·바인드 값 평문 금지.

---

## 시크릿 마스킹

1. `sanitizeAttributes` → `maskSecrets` (M3) 후 allowlist 필터.  
2. `assertSafeAttributes` → 필수 상관 ID + 비허용 키 거부 + Bearer/`sk-`/DSN 패턴 잔존 거부.  
3. Collector redaction allowlist(운영)는 동일 키 집합을 따르되, **앱 계층 거부가 SoR** — live Collector는 Non-goal.

금지: 시크릿 plaintext를 OTel attribute · 로그 · NATS 감사 프레임에 기록 (ARCHITECTURE §1 · §9.2).

---

## 검증

```bash
bash deploy/scripts/check-otel-function-nats-pg.sh
node services/otel/attributes.selftest.js
node services/otel/spans.selftest.js
```

M4 성공 기준: 트레이스에 tenant/session/run id · 시크릿 평문 없음.
