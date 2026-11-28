# crates/ — 플랫폼 Rust 공유 라이브러리 (Phase 0)

계약: [ARCHITECTURE.md](../ARCHITECTURE.md) §1 · §8 · §9.2 · §2.1.  
전환 계획: [ROADMAP.md](../ROADMAP.md) 「플랫폼 서비스 Rust 전환」 · 캔버스 `service-rust-migration` · [`deploy/docs/service-rust-phase0.md`](../deploy/docs/service-rust-phase0.md).

**이 문서 범위:** Cargo workspace 공유 crate 내부 API · Phase 0 스모크 바이너리 · Commands.  
**Non-goals:** 브리지/Gateway cutover(Phase 1+) · live NATS/PG CI 필수 · Admin UI·테넌트 번들.

---

## Workspace

| crate | 역할 |
|-------|------|
| `aura-envelope` | §8 JSON envelope 파싱·직렬화 · 256KB 가드 · Node 패리티 |
| `aura-nats` | async-nats 연결 · **mTLS 옵션 강제**(`nats-tls.js` 패리티) · Core RR / JetStream pull 헬퍼 |
| `aura-tenant-tx` | `set_config('app.tenant_id', $1, true)` 전용 · `false`/세션 SET 금지 |
| `aura-otel` | attribute allowlist · `maskSecrets` 패리티 · 상관 ID 필수 |
| `aura-nats-smoke` | Phase 0 성공 바이너리: Core RR echo + JetStream pull echo · **distroless** 이미지 템플릿 |
| `aura-js-worker` | memory/compliance JetStream pull 워커 (Node `jetstream-worker.js` 패리티) |
| `services/<name>/` | 플랫폼 서비스 **Rust 루트** (`Cargo.toml`·`src/`) · agent/mcp는 `nodejs/`/`python/` · LLM egress client는 `clients/` |

스택 핀: `tokio` · `async-nats` · `serde`/`serde_json` · `reqwest` · (후속) `axum` · `sqlx`. Object Store RustFS 트랙과 **별개**.

---

## 계약 불변 (wire)

- subject / envelope(`type`/`id`/`tenant_id`) / HTTP·Function 이름 / 기존 `check-*.sh` 기대 **변경 금지**.
- Strangler: shadow → canary → cutover → Node deprecate (Phase 1+).

---

## Commands

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p aura-nats-smoke --release
bash deploy/scripts/check-service-rust-phase0.sh
# optional live NATS (lab):
# AURA_NATS_URL=nats://127.0.0.1:4222 cargo run -p aura-nats-smoke
```
