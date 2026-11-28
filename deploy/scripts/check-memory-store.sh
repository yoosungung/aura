#!/usr/bin/env bash
# Gate: store Rust module owns memory_items UPSERT; standalone Deployment retired.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
STORE="$ROOT/services/memory/src/store.rs"
LIB="$ROOT/services/memory/src/lib.rs"
CAPTURE="$ROOT/services/memory/src/capture.rs"
APPLY="$ROOT/deploy/scripts/apply-product.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$HANDLERS" ]] || fail "missing handlers.rs"
[[ -f "$STORE" ]] || fail "missing store.rs"
[[ -f "$LIB" ]] || fail "missing memory lib.rs"
grep -q 'handle_store_request' "$HANDLERS" || fail "handle_store_request required"
grep -q 'INSERT INTO memory_items' "$STORE" || fail "store.rs must INSERT INTO memory_items"
grep -q 'ON CONFLICT (id, memory_type, created_at)' "$STORE" || fail "idempotent ON CONFLICT PK required"
grep -q "set_config('app.tenant_id'" "$STORE" || grep -q 'SET_TENANT_GUC_SQL' "$STORE" \
  || fail "store must use tenant GUC is_local=true"
if grep -Eq 'INSERT INTO|set_config' "$CAPTURE"; then
  fail "capture.rs must not inline SQL (store module boundary)"
fi
if grep -Eq "accepted_stub|/\\*.*stub.*\\*/ SELECT" "$STORE"; then
  fail "store stub SELECT / accepted_stub forbidden"
fi

if grep -Eq '^\s*memory-store\s*$' "$APPLY"; then
  fail "apply-product must not deploy memory-store"
fi
[[ ! -d "$ROOT/deploy/k8s/memory-store" ]] || fail "deploy/k8s/memory-store must be removed"

(cd "$ROOT" && cargo test -p aura-memory --lib) || fail "aura-memory lib tests failed"

ok "store UPSERT module; Deployment retired"
echo "check-memory-store: PASS"
