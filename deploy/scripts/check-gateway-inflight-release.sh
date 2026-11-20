#!/usr/bin/env bash
# M3 static gate: done/error inflight release + agent_invoke ensureAdmitted bypass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCS="$ROOT/deploy/docs/gateway-inflight-release.md"
FAIR="$ROOT/deploy/docs/gateway-fair-queue.md"
RL="$ROOT/services/gateway/rate-limit.js"
GW="$ROOT/services/gateway/gateway.js"
HANDLER="$ROOT/services/agent-invoke/nodejs/handler.js"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$FAIR" ]] || fail "missing $FAIR"
[[ -f "$RL" ]] || fail "missing $RL"
[[ -f "$GW" ]] || fail "missing $GW"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

grep -q 'ensureAdmitted' "$RL" || fail "rate-limit.js must export ensureAdmitted"
grep -q 'releaseInflightFromEvent' "$GW" || fail "gateway.js must export releaseInflightFromEvent"
grep -q 'ensureInvokeAdmitted' "$HANDLER" || fail "handler must call ensureInvokeAdmitted"
grep -q 'aura.events.agent.invoke.done' "$DOCS" || fail "docs must name invoke.done"
grep -q 'ensureAdmitted' "$DOCS" || fail "docs must document ensureAdmitted bypass"
grep -q 'gateway-inflight-release' "$FAIR" || fail "gateway-fair-queue must link gateway-inflight-release.md"

node "$ROOT/services/gateway/gateway.selftest.js" || fail "gateway.selftest.js failed"
node "$ROOT/services/agent-invoke/nodejs/handler.selftest.js" || fail "handler.selftest.js failed"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Fq 'done/error 시 inflight 감산' "$ROADMAP" || fail "ROADMAP must list inflight release item"
grep -Eq '\[x\].*done/error.*inflight' "$ROADMAP" \
  || fail "ROADMAP inflight release + bypass checkbox must be [x]"

ok "gateway inflight release + agent_invoke bypass"
echo "check-gateway-inflight-release: PASS"