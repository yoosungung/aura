#!/usr/bin/env bash
# M3 static gate: Gateway Fair Queue / Rate Limit (§2.2) — no cluster.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/gateway/DESIGN.md"
DOCS="$ROOT/deploy/docs/gateway-fair-queue.md"
GW="$ROOT/services/gateway/gateway.js"
RL="$ROOT/services/gateway/rate-limit.js"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$GW" ]] || fail "missing $GW"
[[ -f "$RL" ]] || fail "missing $RL"

grep -Eqi 'Token Bucket|ratePerSec|rate_per_sec' "$DESIGN" || fail "DESIGN must document Token Bucket"
grep -Eqi 'maxInflight|max_inflight' "$DESIGN" || fail "DESIGN must document maxInflight"
grep -Eqi '429' "$DESIGN" || fail "DESIGN must document 429"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -q 'aura.tasks.agent.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.agent.invoke"

grep -q 'quota\.' "$DOCS" || fail "docs must name quota.{tenant_id} key"
grep -Eq 'ratePerSec|10' "$DOCS" || fail "docs must fix default rate"
grep -Eq 'burst|30' "$DOCS" || fail "docs must fix default burst"
grep -Eq 'maxInflight|20' "$DOCS" || fail "docs must fix default maxInflight"
grep -Eqi 'NATS.*KV|JetStream KV' "$DOCS" || fail "docs must name NATS KV shape"
grep -Eqi '노이지|noisy|V3\.2' "$DOCS" || fail "docs must mention noisy fixture / V3.2"

grep -q 'createTenantRateLimiter' "$RL" || fail "rate-limit.js must export createTenantRateLimiter"
grep -q 'tryAcquire' "$RL" || fail "rate-limit.js must implement tryAcquire"
grep -q 'createMemoryKv' "$RL" || fail "rate-limit.js must provide createMemoryKv"
grep -q 'tryAcquire' "$GW" || fail "gateway must call tryAcquire before publish"
grep -Eq '429|rate_limited|max_inflight' "$GW" || fail "gateway must surface 429"
grep -q 'releaseInflightFromEvent' "$GW" || fail "gateway must expose releaseInflightFromEvent"
grep -Eq 'run\.completed|isTerminalStreamFrame' "$GW" || fail "gateway must release on stream terminal"
grep -Eq 'aura\.events\.agent\.invoke\.(done|error)|isTerminalInvokeEvent' "$GW" "$RL" \
  || fail "must name invoke done/error terminal subjects"

INVOKE="$ROOT/services/agent-invoke/handler.js"
[[ -f "$INVOKE" ]] || fail "missing $INVOKE"
grep -Eq 'ensureInvokeAdmitted|tryAcquire' "$INVOKE" || fail "agent_invoke must reconfirm quota"
grep -Eq 'poison' "$INVOKE" || fail "agent_invoke must mark quota reject as poison"
grep -Eqi '우회|bypass|재확인' "$DOCS" || fail "docs must cover bypass reconfirm"
grep -Eqi 'release|감산|done|error' "$DOCS" || fail "docs must cover done/error release"

if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST" "$RL" "$GW"; then
  fail "gateway/rate-limit must not use PG"
fi

node "$ROOT/services/gateway/gateway.selftest.js" || fail "gateway.selftest.js failed"
node "$ROOT/services/agent-invoke/handler.selftest.js" || fail "handler.selftest.js failed"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*Rate Limiting' "$ROADMAP" \
  || fail "ROADMAP M3 Gateway Rate Limiting checkbox must be [x]"
grep -Eq '\[x\].*inflight 감산' "$ROADMAP" \
  || fail "ROADMAP M3 inflight release checkbox must be [x]"

ok "gateway Fair Queue / Rate Limit + inflight release + bypass reconfirm"
echo "check-gateway-fair-queue: PASS"