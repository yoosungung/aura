#!/usr/bin/env bash
# M1 static gate: multi-tenant HNSW distorted fixture DESIGN (ticket fbed0ce9).
# Exit 0 on PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-hnsw-multitenant-fixture.md"
ARCH="$ROOT/ARCHITECTURE.md"
GUARD="$ROOT/deploy/docs/memory-embed-guard-iterative-scan.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$GUARD" ]] || fail "missing $GUARD"

grep -Eqi '2000' "$DOC" || fail "doc must define large tenant A size 2000"
grep -Eqi 'B.*\*\*2\*\*|테넌트 B.*\*\*2\*\*|B_ROWS|2 rows' "$DOC" \
  || fail "doc must define small tenant B size 2"
grep -Eqi 'LIMIT.*\*\*10\*\*|\*\*10\*\*' "$DOC" || fail "doc must fix LIMIT 10"
grep -Eqi 'halfvec_l2|l2_ops' "$DOC" || fail "doc must use halfvec_l2 fixture ops"
grep -Eqi 'cosine' "$DOC" || fail "doc must record cosine gap / production ops"
grep -Eqi 'iterative_scan' "$DOC" || fail "doc must mention iterative_scan"
grep -Eqi 'relaxed_order' "$DOC" || fail "doc must require relaxed_order for ON"
grep -Eqi 'off' "$DOC" || fail "doc must require OFF contrast"
grep -Eqi '≥ ?1|>= ?1|≥1|ON≥1' "$DOC" || fail "doc must require B ≥1 on ON"
grep -Eqi 'T1' "$DOC" && grep -Eqi 'T2' "$DOC" || fail "doc must state T1/T2 escalation"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'post-filter|post_filter|앱.*필터' "$DOC" || fail "doc must forbid app post-filter"
grep -Eqi 'enable_seqscan' "$DOC" || fail "doc must force HNSW via enable_seqscan=off"
grep -Eqi 'hnsw_mt_fixture' "$DOC" || fail "doc must name fixture table"

grep -Eq 'iterative_scan.*off|off 대조' "$ARCH" \
  || fail "ARCHITECTURE §6.2.3 must keep OFF contrast requirement"
grep -Eq 'T1' "$ARCH" && grep -Eq 'T2' "$ARCH" \
  || fail "ARCHITECTURE §6.2.3 must keep T1/T2 table"
grep -Eqi 'relaxed_order' "$GUARD" || fail "guard doc missing relaxed_order"
grep -qE 'ef_search[^0-9]*40|\*\*40\*\*' "$GUARD" || fail "guard doc missing ef_search=40"

ok "multi-tenant HNSW fixture DESIGN + T1/T2 path"
echo "check-memory-hnsw-multitenant: PASS"
