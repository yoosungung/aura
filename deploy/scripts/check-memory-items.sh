#!/usr/bin/env bash
# M1 static gate: memory_items LIST + short/episodic RANGE + RLS shape (no cluster).
# Exit 0 on PASS. Ticket a181ec17.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_items.sql"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"

grep -q 'PARTITION BY LIST (memory_type)' "$SQL" || fail "parent must PARTITION BY LIST (memory_type)"
grep -q "FOR VALUES IN ('short_term') PARTITION BY RANGE (created_at)" "$SQL" \
  || fail "short_term must be RANGE(created_at) sub-parent"
grep -q "FOR VALUES IN ('episodic') PARTITION BY RANGE (created_at)" "$SQL" \
  || fail "episodic must be RANGE(created_at) sub-parent"
grep -q "FOR VALUES IN ('long_term')" "$SQL" || fail "long_term LIST leaf required"
grep -q "FOR VALUES IN ('semantic')" "$SQL" || fail "semantic LIST leaf required"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "must FORCE ROW LEVEL SECURITY"
grep -q "current_setting('app.tenant_id'" "$SQL" || fail "RLS must use app.tenant_id GUC"
grep -q 'PRIMARY KEY (id, memory_type, created_at)' "$SQL" || fail "PK must include partition keys"
grep -q 'idx_memory_items_tsv' "$SQL" || fail "GIN content_tsv index required"

# Forbidden: FK to memory_items(id) alone; session GUC in this DDL.
if grep -Eiq 'REFERENCES[[:space:]]+memory_items[[:space:]]*\([[:space:]]*id[[:space:]]*\)' "$SQL"; then
  fail "FK to memory_items(id) alone is forbidden (partition key required)"
fi
if grep -Eq "set_config\(\s*'app\.tenant_id'\s*,[^,]+,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$SQL"; then
  fail "session-scoped tenant GUC forbidden in DDL"
fi

ok "memory_items.sql LIST + RANGE parents + FORCE RLS"
echo "check-memory-items: PASS"
