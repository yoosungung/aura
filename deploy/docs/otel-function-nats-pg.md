# OTel (Function·NATS·PG) + 시크릿 마스킹 검증 (M4 · §9.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §9.2.  
내부: [`../../services/otel/DESIGN.md`](../../services/otel/DESIGN.md).  
마스킹(M3): [`nats-mtls-secrets.md`](nats-mtls-secrets.md) · `services/control/secrets-mask.js`.

**이 문서 범위:** Function·NATS·PG span에 **tenant/session/run id** · OTel attribute **허용 목록** · `maskSecrets` 재사용으로 **시크릿 평문 부재** 검증.  
**Non-goals:** Collector/Jaeger 라이브 apply를 CI PASS 필수 조건으로 두지 않음 · auto-instrumentation 전면 · `db.query.parameter.*` 수집 · exporter 벤더 확정 · erase · PITR · M5 대시보드.

수치·성공 기준 출처: ROADMAP M4 («트레이스에 tenant/session/run id; 시크릿 평문 없음»).

---

## 집행 위치

1. **상관키** — 모든 Aura span attribute에 `aura.tenant_id` · `aura.session_id` · `aura.run_id` 필수 (`assertSafeAttributes`).
2. **Function** — `buildFunctionSpanAttributes` → `faas.name` / `aura.function.name` · 선택 `aura.rpc.subject`.
3. **NATS** — `buildNatsSpanAttributes` → `messaging.system.name=nats` · `messaging.operation.name` · `messaging.destination.name`(subject).
4. **PG** — `buildPgSpanAttributes` → `db.system.name=postgresql` · `db.operation.name` · `db.query.summary` · 선택 파라미터화 `db.query.text`. **금지:** DSN · `db.query.parameter.*`.
5. **마스킹** — 입력에 `secrets`/`token`/`authorization`/`api_key`/`password`가 있어도 allowlist 드롭 + `maskSecrets`. 평문 패턴 잔존 시 `plaintext` 거부.

호출측(tracer SDK)은 본 헬퍼 출력만 `span.setAttributes`에 넣는다. raw envelope·resolve secrets 객체를 그대로 올리지 않는다.

---

## Attribute 허용 목록 (요약)

| 키 | 용도 |
|----|------|
| `aura.tenant_id` · `aura.session_id` · `aura.run_id` | 상관 (필수) |
| `faas.name` · `aura.function.name` · `aura.rpc.subject` | Function |
| `messaging.system.name` · `messaging.operation.name` · `messaging.destination.name` | NATS |
| `db.system.name` · `db.operation.name` · `db.query.summary` · `db.query.text` | PG |
| `server.address` · `server.port` · `error.type` | 공통 보조 |

허용 목록 밖 키는 **드롭**. 시크릿 필드명·DSN·쿼리 파라미터 attribute는 목록에 없다.

---

## 검증

```bash
bash deploy/scripts/check-otel-function-nats-pg.sh
node services/otel/attributes.selftest.js
node services/otel/spans.selftest.js
```

M4 성공 기준: **트레이스 속성에 tenant/session/run id** · **시크릿 평문 없음**(selftest + 정적 게이트).
