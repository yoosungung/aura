#!/usr/bin/env bash
# M4 static gate: supernode fixture caps in Rust + docs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-graph-supernode-fixture.md"
TRAV="$ROOT/deploy/docs/memory-graph-traversal.md"
LIB="$ROOT/services/memory/src/lib.rs"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$LIB" ]] || fail "missing memory lib.rs"
[[ -f "$TRAV" ]] || fail "missing $TRAV"

grep -qE '500|\*\*500\*\*' "$DOC" || fail "doc must fix hub_degree = 500"
grep -qE 'supernode_degree_cap|\*\*64\*\*' "$DOC" || fail "doc must reference supernode_degree_cap 64"
grep -qE 'per_hop_limit|\*\*50\*\*' "$DOC" || fail "doc must reference per_hop_limit 50"
grep -Eqi 'OFF|대조|uncapped|hub_degree' "$DOC" || fail "doc must define OFF / uncapped contrast"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"

grep -q 'SUPERNODE_HUB_DEGREE' "$LIB" || fail "lib must define SUPERNODE_HUB_DEGREE"
grep -q '500' "$LIB" || fail "lib hub degree must be 500"
grep -Eqi 'supernode|슈퍼노드' "$DESIGN" || fail "DESIGN must mention supernode fixture"
grep -Eq 'memory-graph-supernode-fixture\.md' "$ROADMAP" || fail "ROADMAP must link supernode fixture"
grep -Eqi 'memory-graph-supernode-fixture|슈퍼노드 픽스처' "$TRAV" \
  || fail "memory-graph-traversal.md must link supernode fixture"

(cd "$ROOT" && cargo test -p aura-memory --lib supernode --offline) || fail "supernode rust test failed"

ok "supernode fixture caps (Rust) + docs"
echo "check-memory-graph-supernode: PASS"
