#!/usr/bin/env bash
# M1 static gate: memory_nodes / memory_edges + RLS shape (no cluster).
# Exit 0 on PASS. Ticket fa6351fa.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_nodes_edges.sql"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"

grep -q 'CREATE TABLE memory_nodes' "$SQL" || fail "memory_nodes table required"
grep -q 'CREATE TABLE memory_edges' "$SQL" || fail "memory_edges table required"
grep -q 'UNIQUE (tenant_id, entity_type, name)' "$SQL" || fail "nodes UNIQUE (tenant_id, entity_type, name) required"
grep -q 'REFERENCES memory_nodes' "$SQL" || fail "edges must REFERENCES memory_nodes"
grep -q 'CHECK (source_node_id <> target_node_id)' "$SQL" || fail "self-loop CHECK required"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "must FORCE ROW LEVEL SECURITY"
grep -q "current_setting('app.tenant_id'" "$SQL" || fail "RLS must use app.tenant_id GUC"

# Edge partial indexes required (ticket 8d3fb9cd / §6.2.4). Detail gate: check-memory-graph-traversal.sh
grep -q 'CREATE INDEX idx_memory_edges_out' "$SQL" || fail "idx_memory_edges_out required"
grep -q 'CREATE INDEX idx_memory_edges_in' "$SQL" || fail "idx_memory_edges_in required"
grep -q 'WHERE valid_until IS NULL' "$SQL" || fail "edge indexes must be partial (valid_until IS NULL)"

# Forbidden: FK to memory_items; session-scoped tenant GUC.
if grep -Eiq 'REFERENCES[[:space:]]+memory_items' "$SQL"; then
  fail "FK to memory_items forbidden (logical item_id only)"
fi
if grep -Eq "set_config\(\s*'app\.tenant_id'\s*,[^,]+,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$SQL"; then
  fail "session-scoped tenant GUC forbidden in DDL"
fi

ok "memory_nodes_edges.sql tables + FORCE RLS"
echo "check-memory-nodes-edges: PASS"
