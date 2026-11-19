#!/usr/bin/env bash
# M5 static gate: PG PITR recurring drill calendar (§9.6).
# Doc + calendar selftest + seed history. Live CNPG = Non-goal for CI.
# Exit 0 on PASS. Ticket db568bf9.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/pg-pitr-drill-calendar.md"
DRILL_DOC="$ROOT/deploy/docs/pg-pitr-drill.md"
CAL="$ROOT/services/ops/pitr-drill/calendar.js"
SELFTEST="$ROOT/services/ops/pitr-drill/calendar.selftest.js"
JSON="$ROOT/services/ops/pitr-drill/calendar.json"
OPS_DESIGN="$ROOT/services/ops/DESIGN.md"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DRILL_DOC" ]] || fail "missing $DRILL_DOC"
[[ -f "$CAL" ]] || fail "missing $CAL"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$JSON" ]] || fail "missing $JSON"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'quarterly|분기' "$DOC" || fail "doc must require quarterly cadence"
grep -Eq '14' "$DOC" || fail "doc must state 14-day stack-change window"
grep -q 'check-pg-pitr-drill-calendar' "$DOC" || fail "doc must name check-pg-pitr-drill-calendar"
grep -q 'calendar.json' "$DOC" || fail "doc must name calendar.json"
grep -Eqi 'lab-1' "$DOC" || fail "doc must seed lab-1"

grep -q 'MIN_CADENCE' "$CAL" || fail "calendar.js must define MIN_CADENCE"
grep -q 'quarterly' "$CAL" || fail "calendar.js must pin quarterly"
grep -q 'STACK_CHANGE_WINDOW_DAYS' "$CAL" || fail "calendar.js must define stack-change window"
grep -q 'evaluateCalendar' "$CAL" || fail "calendar.js must export evaluateCalendar"
grep -q '14' "$CAL" || fail "stack-change window must be 14 days"

grep -q 'min_cadence' "$JSON" || fail "calendar.json must declare min_cadence"
grep -q 'lab-1' "$JSON" || fail "calendar.json must include lab-1 history"
grep -q '"pass": true' "$JSON" || fail "calendar.json lab-1 must pass"

grep -q 'pg-pitr-drill-calendar' "$OPS_DESIGN" || fail "ops DESIGN must document calendar"
grep -Eq 'pg-pitr-drill-calendar\.md|정기.*훈련|drill calendar' "$ARCH" \
  || fail "ARCHITECTURE §9.6 must link calendar"
grep -Eq '\[x\].*정기 PG 복구 훈련 캘린더|\[x\].*pg-pitr-drill-calendar' "$ROADMAP" \
  || fail "ROADMAP calendar checkbox must be [x]"
grep -q 'check-pg-pitr-drill-calendar\|pg-pitr-drill-calendar' "$SETUP" \
  || fail "SETUP must name calendar gate"
grep -Eq 'pg-pitr-drill-calendar|정기.*PITR|PITR.*캘린더' "$AGENTS" \
  || fail "AGENTS must mention PITR calendar"

grep -Eqi 'calendar|캘린더' "$DRILL_DOC" || fail "pg-pitr-drill.md must point at calendar"

node "$SELFTEST" || fail "calendar.selftest.js failed"

# Seed must satisfy evaluateCalendar at committed as-of (lab-1 day)
node - <<NODE
const { evaluateCalendar, loadCalendar } = require("$CAL");
const cal = loadCalendar();
const r = evaluateCalendar({
  now: '2026-11-19T12:00:00.000Z',
  history: cal.history,
  stack_change_at: cal.stack_change_at || null,
});
if (!r.pass) {
  console.error('FAIL: seed calendar not compliant', r);
  process.exit(1);
}
if (!r.quarter_satisfied) {
  console.error('FAIL: 2026-Q4 must be satisfied by lab-1', r);
  process.exit(1);
}
console.log('seed-ok', {
  quarter: r.current_quarter_id,
  next: r.next_due_quarter_id,
});
NODE

ok "PG PITR drill calendar policy"
echo "check-pg-pitr-drill-calendar: PASS"
