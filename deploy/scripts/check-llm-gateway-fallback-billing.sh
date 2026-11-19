#!/usr/bin/env bash
# M5 static gate: LLM Gateway Fallback 모델 + 테넌트 과금 대시보드 (ARCHITECTURE §9.4).
# Exit 0 on PASS. Ticket 9e61a4b0. Non-goals: live provider keys · PG invoice · SPA.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/llm-gateway-fallback-billing.md"
BASE_DOC="$ROOT/deploy/docs/llm-gateway.md"
DESIGN="$ROOT/services/llm-gateway/DESIGN.md"
GW="$ROOT/services/llm-gateway/gateway.js"
SELFTEST="$ROOT/services/llm-gateway/gateway.selftest.js"
DEP="$ROOT/deploy/k8s/llm-gateway/deployment.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$BASE_DOC" ]] || fail "missing $BASE_DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$GW" ]] || fail "missing $GW"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$DEP" ]] || fail "missing $DEP"

# Fallback surface
grep -Eq 'providers|fallbackModels|fallback_used' "$GW" \
  || fail "gateway must implement providers/fallbackModels/fallback_used"
grep -Eq 'all_providers_failed|attempts' "$GW" \
  || fail "gateway must expose all_providers_failed + attempts"
grep -Eqi 'fallback' "$SELFTEST" || fail "selftest must cover fallback"

# Billing dashboard surface
grep -Eq 'handleBillingUsage|aggregateBillingUsage|renderBillingDashboard' "$GW" \
  || fail "gateway must implement billing usage aggregate + dashboard render"
grep -q '/v1/billing/usage' "$DOC" || fail "doc must name /v1/billing/usage"
grep -Eqi 'billing|과금' "$SELFTEST" || fail "selftest must cover billing"

# Docs + DESIGN links
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'Fallback|fallback' "$DOC" || fail "doc must describe Fallback"
grep -q 'llm-gateway-fallback-billing.md' "$DESIGN" \
  || fail "DESIGN must link llm-gateway-fallback-billing.md"
grep -Eq 'handleBillingUsage|billing/usage|Fallback' "$DESIGN" \
  || fail "DESIGN must mention Fallback/billing"

# Deployment stub exposes billing path
grep -q '/v1/billing/usage' "$DEP" \
  || fail "Deployment stub must mention /v1/billing/usage"

# Cross-links + ROADMAP checkbox
grep -Eq 'llm-gateway-fallback-billing\.md|Fallback.*과금|과금 대시보드' "$ARCH" \
  || fail "ARCHITECTURE must link fallback/billing"
grep -Eq '\[x\].*Fallback.*과금|\[x\].*llm-gateway-fallback-billing|\[x\].*Fallback 모델' "$ROADMAP" \
  || fail "ROADMAP Fallback/과금 checkbox must be [x]"
grep -q 'check-llm-gateway-fallback-billing' "$SETUP" \
  || fail "SETUP must name check-llm-gateway-fallback-billing.sh"
grep -Eq 'llm-gateway-fallback-billing|Fallback.*과금' "$AGENTS" \
  || fail "AGENTS must mention fallback/billing"

node "$SELFTEST" || fail "gateway.selftest.js failed"

ok "llm-gateway Fallback chain + tenant billing usage dashboard"
echo "check-llm-gateway-fallback-billing: PASS"
