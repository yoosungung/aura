# DLQ Replay 운영 도구 + 런북 (M5 · §3.2 · §9.7)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §3.2 MaxDeliver·DLQ · §9.7.  
적재 경로(M0): **① Term** — [`SETUP.md`](../SETUP.md) · `smoke-dlq-term.sh`.  
코드: [`services/ops/dlq-replay/`](../../services/ops/dlq-replay/) · CLI [`../scripts/dlq-replay.sh`](../scripts/dlq-replay.sh) · 게이트 [`../scripts/check-dlq-replay.sh`](../scripts/check-dlq-replay.sh).

**이 문서 범위:** `AURA_DLQ` 메시지 **inspect · dry-run · confirm replay** 절차 · envelope 스키마 · 안전 가드.  
**Non-goals:** Advisory(②) 이관 · 자동 cron/무한 replay 루프 · Fission MQT Term 미들웨어 이식 · live NATS를 CI PASS 조건으로 요구.

---

## 왜 운영 도구만인가

| 금지 | 이유 |
|------|------|
| JetStream 자동 이관 | MaxDeliver 초과 시 서버는 재전달만 중단(+advisory). payload 자동 이동 없음 |
| Advisory 구독 이관 | WorkQueue에서 MaxDeliver 후 `stream get` 실패 → payload 유실 위험(② **비채택**) |
| 자동/무한 replay | poison이 워커를 다시 점유·루프. §9.7 명시 금지 |

재처리는 **사람이 원인 수정 후** CLI로 선택 발행한다.

---

## Envelope (path ① Term)

스모크·핸들러가 `aura.dlq.>`에 넣는 JSON:

| 필드 | 필수 | 의미 |
|------|------|------|
| `src` | ✅ | **원본 subject** (replay 대상). `aura.dlq.*` 금지 |
| `echo` 또는 `payload` | ✅ | 원본 본문(객체/문자열) |
| `id` | 권장 | 추적 키 |
| `tries` | 권장 | 마지막 delivery 횟수 |
| `path` | 권장 | `"term"` |
| `error` | 선택 | 마지막 오류 요약(시크릿 금지) |

예시:

```json
{
  "id": "dlqterm-…",
  "src": "aura.tasks.dlq_term_smoke",
  "tries": 3,
  "path": "term",
  "echo": { "id": "dlqterm-…", "path": "term" }
}
```

Replay publish = **`nats pub <src> <echo>`** (DLQ subject가 아님). 헤더 `X-Aura-Dlq-Replay: 1`.

---

## 안전 가드

| 가드 | 동작 |
|------|------|
| `mode=dry_run` | 기본. publish 없음 · plan만 출력 |
| `mode=confirm` | 명시 플래그 있을 때만 실행 |
| `max_batch` | 기본 **20**. 초과분은 `skipped` |
| `src` 검증 | 공백/`aura.dlq.*` → **refuse** (auto-loop 차단) |
| 시크릿 | DLQ·replay 로그에 토큰 plaintext 금지([`nats-mtls-secrets.md`](nats-mtls-secrets.md)) |

---

## 운영 절차

1. **원인 수정** — 핸들러/스키마/쿼터 등 poison 원인 배포·확인.
2. **Inspect** — DLQ depth·샘플 envelope 확인 (`list` / `inspect`).
3. **Dry-run** — `replay --dry-run`으로 `publishes[]` subject가 `aura.tasks.*`(원본)인지 검증.
4. **Confirm** — 소수 seq/`--id`로 `replay --confirm`. 소비자 lag·에러 이벤트 관찰.
5. **잔여** — 재실패 시 다시 Term→DLQ. 원인 미해결이면 replay 중단·티켓에 증거.

모니터링: `AURA_DLQ` message count / depth 알림(임계는 클러스터 DESIGN). 본 슬라이스는 알림 규칙 YAML을 추가하지 않는다.

---

## Commands

```bash
# 오프라인 게이트 (CI)
node services/ops/dlq-replay/replay.selftest.js
bash deploy/scripts/check-dlq-replay.sh

# 라이브 (nats-box · NATS_URL 필요) — CI 비필수
bash deploy/scripts/dlq-replay.sh list
bash deploy/scripts/dlq-replay.sh inspect --seq 42
bash deploy/scripts/dlq-replay.sh replay --dry-run --seq 42
bash deploy/scripts/dlq-replay.sh replay --confirm --seq 42
```

---

## 결정 로그

| 날짜 | 결정 |
|------|------|
| 2026-11-19 | M5: Replay = ops CLI + `planReplay` 가드. Advisory/자동 루프 비채택 유지. live NATS는 선택 스모크. |
