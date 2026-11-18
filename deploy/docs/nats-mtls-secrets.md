# NATS mTLS + 시크릿 마스킹 / TTL 캐시 무효화 (M3 · §9.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.2.  
내부: [`../../services/control/DESIGN.md`](../../services/control/DESIGN.md).  
매니페스트: [`deploy/k8s/nats-mtls/`](../k8s/nats-mtls/).

**이 문서 범위:** NATS 클라이언트 **mTLS**(`verify: true`) · 로그/트레이스 **시크릿 마스킹** · Function 프로세스 시크릿 캐시 **TTL ≤ 60s** + `aura.events.control.secrets.rotated` 무효화.  
**Non-goals:** (선택 F1) subject 샤딩 · live cert 발급을 CI PASS 필수 조건으로 두지 않음 · NATS Account 격리(출시 후) · OTel 전면 배선(M4) · 시크릿 스토어 본구현 · base `deploy/k8s/base/nats.yaml` 로컬 plaintext 스모크 제거.

---

## 집행 위치

1. **서버** — `deploy/k8s/nats-mtls/` overlay: `nats.conf` top-level `tls { … verify: true }` + Secret `aura-nats-mtls` (키만; PEM 값은 out-of-band).
2. **클라이언트** — `buildNatsTlsOptions` / `assertNatsMtlsConnect` (`services/control/nats-tls.js`). `ca`+`cert`+`key` 없으면 연결 거부(`mtls_required`).
3. **마스킹** — `maskSecrets` / `maskSecretsForLog` (`secrets-mask.js`). `secrets`·`token`·`authorization`·`api_key`·`password`·`client_secret` 등 → `***`. `secrets_ref`는 참조 이름이므로 유지.
4. **캐시** — `createSecretsCache` (`secrets-cache.js`). 기본·최대 TTL **60_000 ms**. 로테이션 이벤트 subject = `aura.events.control.secrets.rotated` → 키/`tenant_id` 스코프 또는 전체 무효화.
5. **금지** — 시크릿 plaintext를 `AURA_EVENTS`·DLQ·`aura.stream.*` 프레임·OTel attribute에 기록.

로컬/M0 스모크는 `base/nats.yaml`(plaintext) 유지 가능. **출시·프로덕션 apply**는 `kubectl apply -k deploy/k8s/nats-mtls/` (+ 실 PEM).

---

## 이벤트

| subject | 의미 | 캐시 동작 |
|---------|------|-----------|
| `aura.events.control.secrets.rotated` | 키 로테이션/revoke | `secrets_ref`/`key` → 단건; `tenant_id` → 테넌트 접두; 무스코프 → `invalidateAll` |

페이로드에 시크릿 **값**을 넣지 않는다 — ref/id만.

---

## 배포

| 항목 | 값 |
|------|-----|
| Overlay | `deploy/k8s/nats-mtls/` (base `nats` StatefulSet patch) |
| ConfigMap | `aura-nats-mtls-conf` · `verify: true` |
| Secret | `aura-nats-mtls` · `ca.pem` / `server-*.pem` / `client-*.pem` (값 Non-goal) |
| Monitor | `:8222` HTTP 유지 (KEDA `/jsz`; mTLS verify는 client port만) |

---

## 검증

```bash
bash deploy/scripts/check-nats-mtls-secrets.sh
node services/control/nats-tls.selftest.js
node services/control/secrets-mask.selftest.js
node services/control/secrets-cache.selftest.js
```

M3 성공 기준: **시크릿 평문 로그 없음** · resolve/채널은 mTLS 계약 · TTL≤60s + rotate 무효화 게이트 green.
