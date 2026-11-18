#!/usr/bin/env bash
# M1 static gate: memory_audit monthly RANGE + RLS shape (no cluster).
# Exit 0 on PASS. Ticket 85741c7b.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_audit.sql"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"

grep -q 'PARTITION BY RANGE (created_at)' "$SQL" || fail "parent must PARTITION BY RANGE (created_at)"
grep -q 'PRIMARY KEY (id, created_at)' "$SQL" || fail "PK must include partition key created_at"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "must FORCE ROW LEVEL SECURITY"
grep -q "current_setting('app.tenant_id'" "$SQL" || fail "RLS must use app.tenant_id GUC"
grep -q 'CREATE TABLE memory_audit' "$SQL" || fail "memory_audit table required"

# Soft delete / session GUC / FK to memory_items(id) alone are out of contract.
if grep -Eiq 'valid_until|soft[[:space:]]*delete' "$SQL"; then
  fail "soft delete / valid_until forbidden on memory_audit (partition DROP is SoR)"
fi
if grep -Eiq 'REFERENCES[[:space:]]+memory_items' "$SQL"; then
  fail "FK to memory_items forbidden (partition DROP + logical item_id only)"
fi
if grep -Eq "set_config\(\s*'app\.tenant_id'\s*,[^,]+,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$SQL"; then
  fail "session-scoped tenant GUC forbidden in DDL"
fi

ok "memory_audit.sql RANGE(created_at) + FORCE RLS"
echo "check-memory-audit: PASS"
