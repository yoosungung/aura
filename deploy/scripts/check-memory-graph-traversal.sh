#!/usr/bin/env bash
# M1 static gate: edges partial indexes + graph traversal limits (doc).
# Exit 0 on PASS. Ticket 8d3fb9cd.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_nodes_edges.sql"
DOC="$ROOT/deploy/docs/memory-graph-traversal.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DOC" ]] || fail "missing $DOC"

# Partial hot-path indexes (ARCHITECTURE §6.2.4). Multiline CREATE INDEX → one line.
sql_flat="$(tr '\n' ' ' <"$SQL" | tr -s ' ')"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE INDEX idx_memory_edges_out ON memory_edges \(tenant_id, source_node_id, relation_type\) WHERE valid_until IS NULL' \
  || fail "idx_memory_edges_out must be (tenant_id, source_node_id, relation_type) WHERE valid_until IS NULL"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE INDEX idx_memory_edges_in ON memory_edges \(tenant_id, target_node_id, relation_type\) WHERE valid_until IS NULL' \
  || fail "idx_memory_edges_in must be (tenant_id, target_node_id, relation_type) WHERE valid_until IS NULL"

# DESIGN fixed numbers (ARCHITECTURE draft → M1 lock).
grep -qE 'max_depth[^0-9]*2|\*\*2\*\*.*max_depth|max_depth.*\*\*2\*\*' "$DOC" || fail "doc must fix max_depth = 2"
grep -qE 'per_hop_limit[^0-9]*50|\*\*50\*\*' "$DOC" || fail "doc must fix per_hop_limit = 50"
grep -qE 'max_nodes_total[^0-9]*100|\*\*100\*\*' "$DOC" || fail "doc must fix max_nodes_total = 100"
grep -qE 'max_edges_total[^0-9]*200|\*\*200\*\*' "$DOC" || fail "doc must fix max_edges_total = 200"
grep -qE 'supernode_degree_cap[^0-9]*64|\*\*64\*\*' "$DOC" || fail "doc must fix supernode_degree_cap = 64"
grep -qi 'visited' "$DOC" || fail "doc must require visited set (cycle guard)"
grep -qi 'Non-goals\|본구현\|M4' "$DOC" || fail "doc must state Non-goals / M4 impl"

ok "edges out/in partial indexes + traversal DESIGN numbers"
echo "check-memory-graph-traversal: PASS"
