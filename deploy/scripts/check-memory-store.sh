#!/usr/bin/env bash
# Gate: store is Rust lib (handlers); standalone Deployment retired.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
LIB="$ROOT/services/memory/src/lib.rs"
APPLY="$ROOT/deploy/scripts/apply-product.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$HANDLERS" ]] || fail "missing handlers.rs"
[[ -f "$LIB" ]] || fail "missing memory lib.rs"
grep -q 'handle_store_request' "$HANDLERS" || fail "handle_store_request required"
grep -q "set_config('app.tenant_id'" "$LIB" || grep -q 'tenant_guc_sql\|SET_TENANT_GUC' "$LIB" \
  || fail "memory lib must expose tenant GUC"

if grep -Eq '^\s*memory-store\s*$' "$APPLY"; then
  fail "apply-product must not deploy memory-store"
fi
[[ ! -d "$ROOT/deploy/k8s/memory-store" ]] || fail "deploy/k8s/memory-store must be removed"

(cd "$ROOT" && cargo test -p aura-memory --offline --lib) || fail "aura-memory lib tests failed"

ok "store Rust module kept; Deployment retired"
echo "check-memory-store: PASS"
