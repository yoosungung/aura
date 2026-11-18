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

if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST" "$RL" "$GW"; then
  fail "gateway/rate-limit must not use PG"
fi

node "$ROOT/services/gateway/gateway.selftest.js" || fail "gateway.selftest.js failed"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*Rate Limiting' "$ROADMAP" \
  || fail "ROADMAP M3 Gateway Rate Limiting checkbox must be [x]"

ok "gateway Fair Queue / Rate Limit"
echo "check-gateway-fair-queue: PASS"