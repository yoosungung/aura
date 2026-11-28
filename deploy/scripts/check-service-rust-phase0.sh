#!/usr/bin/env bash
# Phase 0 static gate: Rust workspace · envelope/mTLS/tenant-tx/otel · CI · distroless.
# Exit 0 on PASS. Live NATS optional (AURA_NATS_URL). Non-goals: bridge cutover.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/service-rust-phase0.md"
DESIGN="$ROOT/crates/DESIGN.md"
CARGO="$ROOT/Cargo.toml"
WF="$ROOT/.github/workflows/rust.yml"
SMOKE_DF="$ROOT/crates/aura-nats-smoke/Dockerfile"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
AGENTS="$ROOT/AGENTS.md"
SETUP="$ROOT/deploy/SETUP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$CARGO" ]] || fail "missing $CARGO"
[[ -f "$WF" ]] || fail "missing $WF"
[[ -f "$SMOKE_DF" ]] || fail "missing $SMOKE_DF"

for crate in aura-envelope aura-nats aura-tenant-tx aura-otel aura-nats-smoke; do
  [[ -f "$ROOT/crates/$crate/Cargo.toml" ]] || fail "missing crate $crate"
  grep -q "$crate" "$CARGO" || fail "workspace must list $crate"
done

grep -q 'distroless' "$SMOKE_DF" || fail "smoke Dockerfile must use distroless"
grep -q 'aura-nats-smoke' "$SMOKE_DF" || fail "smoke Dockerfile must build aura-nats-smoke"

grep -q 'cargo test' "$WF" || fail "rust.yml must run cargo test"
grep -q 'clippy' "$WF" || fail "rust.yml must run clippy"

grep -q "SET_TENANT_GUC_SQL\|set_config('app.tenant_id'" "$ROOT/crates/aura-tenant-tx/src/lib.rs" \
  || fail "aura-tenant-tx must expose set_config true SQL"
grep -q ", true)" "$ROOT/crates/aura-tenant-tx/src/lib.rs" \
  || fail "tenant-tx SQL must use is_local true"
# SQL constant must never use is_local=false (call-site bool checks may mention false).
if grep -E "set_config\('app\.tenant_id', \\\$1, false\)" "$ROOT/crates/aura-tenant-tx/src/lib.rs"; then
  fail "forbidden set_config false SQL"
fi

grep -q 'MAX_NATS_PAYLOAD_BYTES\|262_144\|262144' "$ROOT/crates/aura-envelope/src/lib.rs" \
  || fail "envelope must enforce 256KiB cap"
grep -q 'mtls_required\|build_nats_tls_options' "$ROOT/crates/aura-nats/src/lib.rs" \
  || fail "aura-nats must enforce mTLS options"
grep -q 'mask_secrets\|MASK' "$ROOT/crates/aura-otel/src/lib.rs" \
  || fail "aura-otel must mask secrets"
grep -q 'aura.tenant_id' "$ROOT/crates/aura-otel/src/lib.rs" \
  || fail "aura-otel must require aura.tenant_id"

grep -Eq 'service-rust-phase0|crates/DESIGN' "$AGENTS" \
  || fail "AGENTS must mention Phase 0 / crates"
grep -Eq 'Phase 0|service-rust-phase0' "$ROADMAP" \
  || fail "ROADMAP must track Phase 0"
grep -q '\"type\"' "$ARCH" || fail "ARCHITECTURE §8 must define type field"
grep -Eqi 'envelope|§8' "$DESIGN" || fail "DESIGN must reference envelope §8"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eq 'Core RR|JetStream' "$DOC" || fail "doc must name Core RR + JetStream success"

if command -v cargo >/dev/null 2>&1; then
  (cd "$ROOT" && cargo test --workspace --quiet) || fail "cargo test failed"
  (cd "$ROOT" && cargo clippy --workspace --all-targets -- -D warnings) \
    || fail "cargo clippy failed"
  ok "cargo test + clippy"
else
  echo "WARN: cargo not installed — skipped compile gate"
fi

# Optional live NATS
if [[ -n "${AURA_NATS_URL:-}" ]]; then
  (cd "$ROOT" && cargo run -q -p aura-nats-smoke) || fail "live aura-nats-smoke failed"
  ok "live Core RR + JetStream pull"
else
  ok "live NATS skipped (AURA_NATS_URL unset)"
fi

grep -q 'check-service-rust-phase0' "$SETUP" || fail "SETUP must name check-service-rust-phase0.sh"

ok "Phase 0 workspace · parity · CI · distroless"
echo "check-service-rust-phase0: PASS"
