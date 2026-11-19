#!/usr/bin/env bash
# M4 static gate: supernode fixture — hub degree ≫ cap, walk stays bounded.
# Exit 0 on PASS. Ticket aab88aa0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-graph-supernode-fixture.md"
TRAV="$ROOT/deploy/docs/memory-graph-traversal.md"
FIX="$ROOT/services/memory/recall/supernode-fixture.js"
TEST="$ROOT/services/memory/recall/supernode-fixture.selftest.js"
WALK="$ROOT/services/memory/recall/graph-walk.js"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$FIX" ]] || fail "missing $FIX"
[[ -f "$TEST" ]] || fail "missing $TEST"
[[ -f "$WALK" ]] || fail "missing $WALK"
[[ -f "$TRAV" ]] || fail "missing $TRAV"

grep -qE '500|\*\*500\*\*' "$DOC" || fail "doc must fix hub_degree = 500"
grep -qE 'supernode_degree_cap|\*\*64\*\*' "$DOC" || fail "doc must reference supernode_degree_cap 64"
grep -qE 'per_hop_limit|\*\*50\*\*' "$DOC" || fail "doc must reference per_hop_limit 50"
grep -Eqi 'OFF|대조|uncapped|hub_degree' "$DOC" || fail "doc must define OFF / uncapped contrast"
grep -Eqi 'wall|쿼리 시간|2000' "$DOC" || fail "doc must bound query wall clock"
grep -Eqi 'LIMIT' "$DOC" || fail "doc must require query LIMIT ≤ cap"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eq 'supernode-fixture\.js|walkGraph' "$DOC" || fail "doc must point at fixture / walk"

grep -q 'HUB_DEGREE' "$FIX" || fail "supernode-fixture.js must define HUB_DEGREE"
grep -q '500' "$FIX" || fail "supernode-fixture.js must set hub degree 500"
grep -q 'makeSupernodeClient\|buildSupernodeFixture' "$FIX" || fail "fixture helpers missing"
grep -q 'LIMIT' "$WALK" || fail "graph-walk.js must use SQL LIMIT"

grep -Eqi 'supernode|슈퍼노드' "$DESIGN" || fail "DESIGN must mention supernode fixture"
grep -Eq 'memory-graph-supernode-fixture\.md' "$ROADMAP" \
  || fail "ROADMAP must link memory-graph-supernode-fixture.md"
grep -Eq '\[x\].*슈퍼노드 픽스처|\[x\].*supernode' "$ROADMAP" \
  || fail "ROADMAP M4 supernode checkbox must be [x]"

# Traversal doc should no longer treat fixture as unimplemented non-goal-only
grep -Eqi 'memory-graph-supernode-fixture|슈퍼노드 픽스처' "$TRAV" \
  || fail "memory-graph-traversal.md must link supernode fixture"

node "$TEST" || fail "supernode-fixture.selftest.js failed"

ok "supernode fixture DESIGN + bounded walk selftest"
echo "check-memory-graph-supernode: PASS"
