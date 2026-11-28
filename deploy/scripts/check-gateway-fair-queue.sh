#!/usr/bin/env bash
# Gateway Fair Queue / Rate Limit — Rust parity (no Node).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/gateway/DESIGN.md"
DOCS="$ROOT/deploy/docs/gateway-fair-queue.md"
LIB="$ROOT/services/gateway/src/lib.rs"
RL="$ROOT/services/gateway/src/rate_limit.rs"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$LIB" ]] || fail "missing gateway lib.rs"
[[ -f "$RL" ]] || fail "missing rate_limit.rs"
[[ ! -d "$ROOT/services/gateway/js" ]] || fail "gateway/js must be removed"

grep -Eqi 'Token Bucket|ratePerSec|rate_per_sec' "$DESIGN" || fail "DESIGN must document Token Bucket"
grep -Eqi 'maxInflight|max_inflight' "$DESIGN" || fail "DESIGN must document maxInflight"
grep -Eqi '429' "$DESIGN" || fail "DESIGN must document 429"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"

grep -q 'quota\.' "$DOCS" || fail "docs must name quota.{tenant_id} key"
grep -Eq 'ratePerSec|10' "$DOCS" || fail "docs must fix default rate"
grep -Eq 'burst|30' "$DOCS" || fail "docs must fix default burst"
grep -Eq 'maxInflight|20' "$DOCS" || fail "docs must fix default maxInflight"
grep -Eqi 'NATS.*KV|JetStream KV' "$DOCS" || fail "docs must name NATS KV shape"

grep -Eqi 'try_acquire|TryAcquire|rate_limit' "$RL" || fail "rate_limit.rs must implement acquire"
grep -Eqi '429|rate_limited|max_inflight|inflight' "$LIB" "$RL" \
  || fail "gateway rust must surface rate/inflight limits"

(cd "$ROOT" && cargo test -p aura-gateway --offline) || fail "aura-gateway tests failed"

grep -Eq '\[x\].*Rate Limiting' "$ROADMAP" \
  || fail "ROADMAP M3 Gateway Rate Limiting checkbox must be [x]"

ok "gateway fair queue / RL (Rust)"
echo "check-gateway-fair-queue: PASS"
