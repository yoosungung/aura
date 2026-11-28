#!/usr/bin/env bash
# Gate: embed is Rust lib plan; standalone Deployment retired.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/services/memory/src/lib.rs"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
APPLY="$ROOT/deploy/scripts/apply-product.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$LIB" ]] || fail "missing memory lib.rs"
grep -q 'should_skip_embed' "$LIB" || fail "should_skip_embed required"
grep -q 'handle_embed_request' "$HANDLERS" || fail "handle_embed_request required"

if grep -Eq '^\s*memory-embed\s*$' "$APPLY"; then
  fail "apply-product must not deploy memory-embed"
fi
[[ ! -d "$ROOT/deploy/k8s/memory-embed" ]] || fail "deploy/k8s/memory-embed must be removed"

(cd "$ROOT" && cargo test -p aura-memory --lib short_term_embed --offline) || fail "embed skip tests failed"

ok "embed Rust module kept; Deployment retired"
echo "check-memory-embed: PASS"
