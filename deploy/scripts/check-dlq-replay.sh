#!/usr/bin/env bash
# M5 static gate: DLQ Replay ops tool + runbook (§3.2 · §9.7).
# Doc + planner selftest + CLI presence. Live NATS = Non-goal for CI.
# Exit 0 on PASS. Ticket 28cc3d9a.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/dlq-replay.md"
CLI="$ROOT/deploy/scripts/dlq-replay.sh"
REPLAY="$ROOT/services/ops/dlq-replay/replay.js"
SELFTEST="$ROOT/services/ops/dlq-replay/replay.selftest.js"
OPS_DESIGN="$ROOT/services/ops/DESIGN.md"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"
SMOKE_INNER="$ROOT/deploy/scripts/smoke-dlq-term-inner.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$CLI" ]] || fail "missing $CLI"
[[ -x "$CLI" ]] || fail "dlq-replay.sh must be executable"
[[ -f "$REPLAY" ]] || fail "missing $REPLAY"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$SMOKE_INNER" ]] || fail "missing smoke-dlq-term-inner (Term path prerequisite)"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'dry-run|dry_run' "$DOC" || fail "doc must require dry-run"
grep -Eqi 'confirm' "$DOC" || fail "doc must require confirm for live replay"
grep -Eq 'AURA_DLQ|aura\.dlq' "$DOC" || fail "doc must name AURA_DLQ / aura.dlq"
grep -Eqi 'src' "$DOC" || fail "doc must define envelope src"
grep -Eqi 'Advisory|자동.*replay|무한' "$DOC" || fail "doc must forbid Advisory / auto infinite replay"
grep -q 'check-dlq-replay' "$DOC" || fail "doc must name check-dlq-replay"
grep -q 'dlq-replay.sh' "$DOC" || fail "doc must name dlq-replay.sh"

grep -q 'DLQ_STREAM\|AURA_DLQ' "$REPLAY" || fail "replay.js must pin AURA_DLQ"
grep -q 'src_is_dlq\|aura\.dlq' "$REPLAY" || fail "replay.js must refuse aura.dlq.* targets"
grep -q 'dry_run' "$REPLAY" || fail "replay.js must support dry_run"
grep -q 'confirm' "$REPLAY" || fail "replay.js must support confirm"
grep -q 'max_batch\|DEFAULT_MAX_BATCH' "$REPLAY" || fail "replay.js must cap max_batch"
grep -q 'auto_loop' "$REPLAY" || fail "replay.js must expose auto_loop=false"

grep -q 'dlq-replay' "$OPS_DESIGN" || fail "ops DESIGN must document dlq-replay"
grep -q 'dlq-replay.md' "$ARCH" || fail "ARCHITECTURE §9.7 must link dlq-replay.md"
grep -Eq '\[x\].*DLQ Replay|\[x\].*dlq-replay' "$ROADMAP" \
  || fail "ROADMAP DLQ Replay checkbox must be [x]"
grep -q 'check-dlq-replay\|dlq-replay' "$SETUP" \
  || fail "SETUP must name dlq-replay / check-dlq-replay"
grep -Eq 'dlq-replay|DLQ Replay' "$AGENTS" \
  || fail "AGENTS must mention DLQ Replay"

node "$SELFTEST" || fail "replay.selftest.js failed"

ok "DLQ Replay ops tool + runbook"
echo "check-dlq-replay: PASS"
