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

grep -Eqi '500' "$DOC" || fail "doc must define large tenant A size 500"
grep -Eqi '테넌트 B|\*\*2\*\*|B.*2' "$DOC" || fail "doc must define small tenant B size 2"
grep -Eqi 'LIMIT|Top-K|\*\*10\*\*' "$DOC" || fail "doc must fix LIMIT/Top-K 10"
grep -Eqi 'iterative_scan' "$DOC" || fail "doc must mention iterative_scan"
grep -Eqi 'relaxed_order' "$DOC" || fail "doc must require relaxed_order for ON"
grep -Eqi '전역 Top-K|Top-K|off' "$DOC" || fail "doc must require OFF / global Top-K contrast"
grep -Eqi '≥ ?1|>= ?1|≥1|ON≥1' "$DOC" || fail "doc must require B ≥1 on ON"
grep -Eqi 'T1' "$DOC" && grep -Eqi 'T2' "$DOC" || fail "doc must state T1/T2 escalation"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'post-filter|post_filter|앱.*필터' "$DOC" || fail "doc must forbid app post-filter"
grep -Eqi 'UNIQUE|btree|enable_seqscan|bitmapscan' "$DOC" \
  || fail "doc must note smoke-only UNIQUE drop / scan GUC to force HNSW"

grep -Eq 'iterative_scan.*off|off 대조' "$ARCH" \
  || fail "ARCHITECTURE §6.2.3 must keep OFF contrast requirement"
grep -Eq 'T1' "$ARCH" && grep -Eq 'T2' "$ARCH" \
  || fail "ARCHITECTURE §6.2.3 must keep T1/T2 table"
grep -Eqi 'relaxed_order' "$GUARD" || fail "guard doc missing relaxed_order"
grep -qE 'ef_search[^0-9]*40|\*\*40\*\*' "$GUARD" || fail "guard doc missing ef_search=40"

ok "multi-tenant HNSW fixture DESIGN + T1/T2 path"
echo "check-memory-hnsw-multitenant: PASS"
