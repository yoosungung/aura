#!/usr/bin/env bash
# M1 static gate: short_term/episodic/audit TTL policy numbers (doc-only).
# Validates deploy/docs/memory-ttl-policy.md. Exit 0 on PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-ttl-policy.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"

grep -q "14일\|14 days\|interval '14 days'" "$DOC" || fail "doc must fix short_term hot = 14 days"
grep -q "24개월\|24 months\|interval '24 months'" "$DOC" || fail "doc must fix episodic hot = 24 months"
grep -q "12개월\|12 months\|interval '12 months'" "$DOC" || fail "doc must fix audit hot = 12 months"
grep -q 'aura.tasks.memory.ttl' "$DOC" || fail "doc must name aura.tasks.memory.ttl"
grep -qE '일 1회|daily' "$DOC" || fail "doc must fix DROP cadence = daily (일 1회)"
grep -qi 'DROP' "$DOC" || fail "doc must state partition DROP"
grep -qi 'Non-goals\|본구현' "$DOC" || fail "doc must state Non-goals (no job impl in M1)"

ok "memory-ttl-policy.md 14d / 24mo / 12mo + daily + aura.tasks.memory.ttl"
echo "check-memory-ttl: PASS"
