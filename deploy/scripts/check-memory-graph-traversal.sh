#!/usr/bin/env bash
# Graph traversal: edges partial indexes + M1 limits + M4 walk implementation gate.
# Exit 0 on PASS. Tickets: 8d3fb9cd (M1) · b81d8eee (M4 walk).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_nodes_edges.sql"
DOC="$ROOT/deploy/docs/memory-graph-traversal.md"
WALK="$ROOT/services/memory/recall/graph-walk.js"
WALK_TEST="$ROOT/services/memory/recall/graph-walk.selftest.js"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$WALK" ]] || fail "missing $WALK"
[[ -f "$WALK_TEST" ]] || fail "missing $WALK_TEST"

# Partial hot-path indexes (ARCHITECTURE §6.2.4). Multiline CREATE INDEX → one line.
sql_flat="$(tr '\n' ' ' <"$SQL" | tr -s ' ')"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE INDEX idx_memory_edges_out ON memory_edges \(tenant_id, source_node_id, relation_type\) WHERE valid_until IS NULL' \
  || fail "idx_memory_edges_out must be (tenant_id, source_node_id, relation_type) WHERE valid_until IS NULL"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE INDEX idx_memory_edges_in ON memory_edges \(tenant_id, target_node_id, relation_type\) WHERE valid_until IS NULL' \
  || fail "idx_memory_edges_in must be (tenant_id, target_node_id, relation_type) WHERE valid_until IS NULL"

# DESIGN fixed numbers
grep -qE 'max_depth[^0-9]*2|\*\*2\*\*.*max_depth|max_depth.*\*\*2\*\*' "$DOC" || fail "doc must fix max_depth = 2"
grep -qE 'per_hop_limit[^0-9]*50|\*\*50\*\*' "$DOC" || fail "doc must fix per_hop_limit = 50"
grep -qE 'max_nodes_total[^0-9]*100|\*\*100\*\*' "$DOC" || fail "doc must fix max_nodes_total = 100"
grep -qE 'max_edges_total[^0-9]*200|\*\*200\*\*' "$DOC" || fail "doc must fix max_edges_total = 200"
grep -qE 'supernode_degree_cap[^0-9]*64|\*\*64\*\*' "$DOC" || fail "doc must fix supernode_degree_cap = 64"
grep -qi 'visited' "$DOC" || fail "doc must require visited set (cycle guard)"

# M4 walk implementation present
grep -q 'GRAPH_LIMITS' "$WALK" || fail "graph-walk.js must export GRAPH_LIMITS"
grep -q 'walkGraph' "$WALK" || fail "graph-walk.js must export walkGraph"
grep -q 'expandLimitForNode\|per_hop_limit' "$WALK" || fail "graph-walk.js must apply per_hop / supernode cap"
grep -Eq 'source_node_id|idx_memory_edges_out|memory_edges' "$WALK" || fail "graph-walk.js must query out edges"
grep -Eq 'target_node_id|idx_memory_edges_in' "$WALK" || fail "graph-walk.js must query in edges"
grep -Eq 'valid_from\s*<=\s*now\(\)|VALID_EDGE_PREDICATE' "$WALK" || fail "graph-walk.js must use valid edge predicate"
if grep -Eqi 'WITH[[:space:]]+RECURSIVE[[:space:]]+[a-zA-Z_]' "$WALK"; then
  fail "graph-walk.js must not use WITH RECURSIVE CTE"
fi
grep -Eqi 'walk|graph-walk|방어적' "$DESIGN" || fail "DESIGN must document graph walk"
grep -Eq '\[x\].*recall graph|\[x\].*방어적.*1–2홉|\[x\].*방어적.*1-2홉' "$ROADMAP" \
  || fail "ROADMAP M4 recall graph checkbox must be [x]"

node "$WALK_TEST" || fail "graph-walk.selftest.js failed"

ok "edges out/in partial indexes + traversal limits + M4 walk"
echo "check-memory-graph-traversal: PASS"
