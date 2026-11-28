# 플랫폼 서비스 Rust — Phase 0 기반

**이 문서 범위:** Cargo workspace · 공유 crate · clippy/test CI · distroless 스모크 이미지 · async-nats mTLS 가드 · envelope 패리티 · Core RR + JetStream pull echo.  
**Non-goals:** 브리지 cutover · Gateway/LLM · control · memory · invoke · live NATS/PG CI 필수 · Object Store RustFS(별 트랙).

게이트: `bash deploy/scripts/check-service-rust-phase0.sh`  
DESIGN: [`crates/DESIGN.md`](../../crates/DESIGN.md)  
계획: [ROADMAP.md](../../ROADMAP.md) 「플랫폼 서비스 Rust 전환」 · 캔버스 `service-rust-migration`.

---

## 성공 기준

| 항목 | 검증 |
|------|------|
| Cargo workspace | `crates/aura-{envelope,nats,tenant-tx,otel,nats-smoke}` |
| envelope 패리티 | `aura-envelope` 단위 테스트 ≡ ARCHITECTURE §8 |
| mTLS 가드 | `aura-nats` — ca/cert/key 없으면 connect 거부(`require_mtls` 기본) |
| tenant GUC | `aura-tenant-tx` SQL이 `set_config(..., true)`만 · `false` 금지 |
| otel/mask | `aura-otel` — Node `maskSecrets`/allowlist 패리티 픽스처 |
| Core RR + JS pull | `aura-nats-smoke` (단위 mock + optional `AURA_NATS_URL`) |
| CI | `.github/workflows/rust.yml` — `cargo test` + `clippy -D warnings` |
| 이미지 | `crates/aura-nats-smoke/Dockerfile` distroless (템플릿) |

---

## Strangler 메모

Phase 0는 **실행 기반만**. subject 변경 금지. Phase 1에서 rpc-bridge → task-bridge를 동일 queue-group/durable로 병행 합류한다.
