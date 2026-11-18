#!/usr/bin/env bash
# M3 static gate: LLM Gateway min + Function egress-only-via-gateway (ARCHITECTURE §9.4).
# Exit 0 on PASS. Ticket b7910957. Non-goals: live provider keys · Fallback/billing dashboard · NATS mTLS · F1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/llm-gateway.md"
DESIGN="$ROOT/services/llm-gateway/DESIGN.md"
GW="$ROOT/services/llm-gateway/gateway.js"
CLIENT="$ROOT/services/llm-gateway/client.js"
SELFTEST="$ROOT/services/llm-gateway/gateway.selftest.js"
DEP="$ROOT/deploy/k8s/llm-gateway/deployment.yaml"
SVC="$ROOT/deploy/k8s/llm-gateway/service.yaml"
KUST="$ROOT/deploy/k8s/llm-gateway/kustomization.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"
EGRESS_DOC="$ROOT/deploy/docs/egress-block-verify.md"
NP="$ROOT/deploy/k8s/sandbox-egress/networkpolicy-sandbox-egress.yaml"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$GW" ]] || fail "missing $GW"
[[ -f "$CLIENT" ]] || fail "missing $CLIENT"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$SVC" ]] || fail "missing $SVC"
[[ -f "$KUST" ]] || fail "missing $KUST"

# Client: provider direct forbidden; gateway hosts only
grep -q 'assertFunctionLlmEgress\|provider_direct_forbidden' "$CLIENT" \
  || fail "client must assertFunctionLlmEgress / provider_direct_forbidden"
grep -q 'api.openai.com' "$CLIENT" || fail "client must blocklist api.openai.com"
grep -q 'aura-llm-gateway' "$CLIENT" || fail "client must allow aura-llm-gateway"
grep -q 'createLlmGatewayClient' "$CLIENT" || fail "client must export createLlmGatewayClient"

# Gateway: chat path + rate + circuit + usage
grep -Eq 'chat/completions|createLlmGateway' "$GW" || fail "gateway must implement chat completions"
grep -Eqi 'rate|bucket|429|rate_limited' "$GW" || fail "gateway must rate-limit tenants"
grep -Eqi 'circuit' "$GW" || fail "gateway must have circuit breaker"
grep -Eqi 'cost_usd|usage|tokens' "$GW" || fail "gateway must log usage/cost"

# Docs
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'Function|Egress|Gateway만|gateway만' "$DOC" || fail "doc must lock Function→Gateway-only egress"
grep -q '/v1/chat/completions' "$DOC" || fail "doc must name /v1/chat/completions"
grep -q 'aura-llm-gateway' "$DOC" || fail "doc must name aura-llm-gateway"
grep -q 'llm-gateway.md' "$DESIGN" || fail "DESIGN must link llm-gateway.md"

# K8s: replicas≥2, app label for NP peer, no MQT
grep -q 'app: aura-llm-gateway' "$DEP" || fail "Deployment must label app: aura-llm-gateway"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$DEP" \
  || fail "Deployment replicas must be ≥ 2"
grep -q 'aura-llm-gateway' "$SVC" || fail "Service must be aura-llm-gateway"
if grep -Eqi 'MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$DEP" "$SVC" "$KUST"; then
  fail "llm-gateway must not use MQT/ScaledObject"
fi

# Cross-links + ROADMAP checkbox
grep -Eq 'llm-gateway\.md|services/llm-gateway' "$ARCH" \
  || fail "ARCHITECTURE must link llm-gateway"
grep -Eq '\[x\].*LLM Gateway|\[x\].*llm-gateway' "$ROADMAP" \
  || fail "ROADMAP LLM Gateway checkbox must be [x]"
grep -q 'check-llm-gateway' "$SETUP" || fail "SETUP must name check-llm-gateway.sh"
grep -q 'llm-gateway' "$AGENTS" || fail "AGENTS must mention llm-gateway"

# Egress NP still peers gateway
[[ -f "$NP" ]] || fail "missing sandbox NP"
grep -q 'aura-llm-gateway' "$NP" || fail "sandbox NP must allow aura-llm-gateway"
grep -Eqi 'llm-gateway|LLM Gateway' "$EGRESS_DOC" || fail "egress doc must reference LLM Gateway"

node "$SELFTEST" || fail "gateway.selftest.js failed"

ok "llm-gateway client egress guard + gateway RL/circuit + Deployment≥2"
echo "check-llm-gateway: PASS"
