#!/usr/bin/env bash
# Graph traversal: edges partial indexes + walk caps in Rust.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_nodes_edges.sql"
DOC="$ROOT/deploy/docs/memory-graph-traversal.md"
LIB="$ROOT/services/memory/src/lib.rs"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$LIB" ]] || fail "missing memory lib.rs"

sql_flat="$(tr '\n' ' ' <"$SQL" | tr -s ' ')"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE INDEX idx_memory_edges_out ON memory_edges \(tenant_id, source_node_id, relation_type\) WHERE valid_until IS NULL' \
  || fail "idx_memory_edges_out must be (tenant_id, source_node_id, relation_type) WHERE valid_until IS NULL"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE INDEX idx_memory_edges_in ON memory_edges \(tenant_id, target_node_id, relation_type\) WHERE valid_until IS NULL' \
  || fail "idx_memory_edges_in must be (tenant_id, target_node_id, relation_type) WHERE valid_until IS NULL"

grep -qE 'max_depth[^0-9]*2|\*\*2\*\*.*max_depth|max_depth.*\*\*2\*\*' "$DOC" || fail "doc must fix max_depth = 2"
grep -qE 'per_hop_limit[^0-9]*50|\*\*50\*\*' "$DOC" || fail "doc must fix per_hop_limit = 50"
grep -qE 'max_nodes_total[^0-9]*100|\*\*100\*\*' "$DOC" || fail "doc must fix max_nodes_total = 100"
grep -qE 'max_edges_total[^0-9]*200|\*\*200\*\*' "$DOC" || fail "doc must fix max_edges_total = 200"
grep -qE 'supernode_degree_cap[^0-9]*64|\*\*64\*\*' "$DOC" || fail "doc must fix supernode_degree_cap = 64"
grep -qi 'visited' "$DOC" || fail "doc must require visited set (cycle guard)"

grep -q 'GRAPH_MAX_DEPTH' "$LIB" || fail "lib must define GRAPH_MAX_DEPTH"
grep -q 'GRAPH_PER_HOP_LIMIT' "$LIB" || fail "lib must define GRAPH_PER_HOP_LIMIT"
grep -q 'GRAPH_SUPERNODE_DEGREE_CAP' "$LIB" || fail "lib must define GRAPH_SUPERNODE_DEGREE_CAP"
grep -Eqi 'graph|walk|슈퍼노드|supernode' "$DESIGN" || fail "DESIGN must cover graph walk"
grep -Eq 'memory-graph-traversal\.md' "$ROADMAP" || fail "ROADMAP must link graph traversal"

(cd "$ROOT" && cargo test -p aura-memory --lib supernode --offline) || fail "graph/supernode rust tests failed"

ok "graph traversal indexes + Rust walk caps"
echo "check-memory-graph-traversal: PASS"
