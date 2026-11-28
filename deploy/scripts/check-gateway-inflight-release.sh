#!/usr/bin/env bash
# Gateway inflight release contract — Rust parity.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/gateway-inflight-release.md"
LIB="$ROOT/services/gateway/src/lib.rs"
RL="$ROOT/services/gateway/src/rate_limit.rs"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$LIB" ]] || fail "missing gateway lib.rs"
[[ -f "$RL" ]] || fail "missing rate_limit.rs"
[[ ! -d "$ROOT/services/gateway/js" ]] || fail "gateway/js must be removed"

grep -Eqi 'release|inflight' "$DOC" || fail "doc must cover inflight release"
grep -Eqi 'release|inflight' "$LIB" "$RL" || fail "gateway rust must implement release/inflight"

(cd "$ROOT" && cargo test -p aura-gateway --offline) || fail "aura-gateway tests failed"

grep -Eq '\[x\].*inflight' "$ROADMAP" \
  || fail "ROADMAP must cover inflight release"

ok "gateway inflight release (Rust)"
echo "check-gateway-inflight-release: PASS"
