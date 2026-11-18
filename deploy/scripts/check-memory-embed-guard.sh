#!/usr/bin/env bash
# M1 static gate: short_term embed refuse + pgvector≥0.8 / ef_search / iterative_scan DESIGN.
# Exit 0 on PASS. Ticket 6dfc4c4a. Distorted-tenant fixture = separate ticket.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_embeddings.sql"
DOC="$ROOT/deploy/docs/memory-embed-guard-iterative-scan.md"
ARCH="$ROOT/ARCHITECTURE.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$ARCH" ]] || fail "missing $ARCH"

sql_flat="$(tr '\n' ' ' <"$SQL" | tr -s ' ')"

# DDL SoR: short_term cannot land in memory_embeddings.
printf '%s\n' "$sql_flat" | grep -Eq "CHECK \(memory_type IN \('episodic', 'long_term', 'semantic'\)\)" \
  || fail "DDL must CHECK memory_type excludes short_term"

# DESIGN: dual-path guard + iterative_scan numbers.
grep -qi 'short_term' "$DOC" || fail "doc must mention short_term refuse"
grep -Eqi 'DDL|CHECK' "$DOC" || fail "doc must state DDL CHECK path"
grep -Eqi 'app|embed Function|aura\.tasks\.memory\.embed|앱' "$DOC" || fail "doc must state app-path refuse (M2)"
grep -Eqi '0\.8|≥ 0\.8|>= 0\.8' "$DOC" || fail "doc must require pgvector ≥ 0.8"
grep -Eqi 'iterative_scan.*relaxed_order|relaxed_order' "$DOC" || fail "doc must fix iterative_scan = relaxed_order"
grep -qE 'ef_search[^0-9]*40|\*\*40\*\*.*ef_search|ef_search.*\*\*40\*\*' "$DOC" \
  || fail "doc must fix ef_search = 40"
grep -qE 'max_scan_tuples[^0-9]*20000|\*\*20000\*\*|max_scan_tuples.*\*\*20[,_]?000\*\*' "$DOC" \
  || fail "doc must fix max_scan_tuples = 20000"
grep -qi 'post-filter\|post_filter\|앱.*필터' "$DOC" || fail "doc must forbid app post-filter"
grep -qi 'Non-goals\|본구현\|픽스처' "$DOC" || fail "doc must state Non-goals / fixture scope"

# ARCHITECTURE placeholders must be locked to DESIGN numbers.
grep -Eq 'SET LOCAL hnsw\.ef_search = 40' "$ARCH" \
  || fail "ARCHITECTURE §6.3 must SET LOCAL hnsw.ef_search = 40 (not placeholder)"
grep -Eq 'hnsw\.iterative_scan = relaxed_order' "$ARCH" \
  || fail "ARCHITECTURE must require iterative_scan = relaxed_order"
if grep -Eq 'ef_search = <M1' "$ARCH"; then
  fail "ARCHITECTURE still has ef_search M1 placeholder"
fi

ok "short_term embed guard DDL + iterative_scan DESIGN numbers"
echo "check-memory-embed-guard: PASS"
