#!/usr/bin/env bash
# M3 static gate: Gateway run_id + SSE/WS bridge + principal auth (no cluster).
# Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/gateway/DESIGN.md"
DOCS="$ROOT/deploy/docs/gateway-sse-ws.md"
GW_DIR="$ROOT/services/gateway"
K8S_DIR="$ROOT/deploy/k8s/gateway"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -d "$GW_DIR" ]] || fail "missing $GW_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN contracts
grep -q 'run_id' "$DESIGN" || fail "DESIGN must name run_id"
grep -q 'aura.stream.' "$DESIGN" || fail "DESIGN must name aura.stream.<run_id>"
grep -q 'aura.tasks.agent.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.agent.invoke"
grep -Eqi 'SSE|WebSocket|WS' "$DESIGN" || fail "DESIGN must name SSE/WS"
grep -Eqi 'principal' "$DESIGN" || fail "DESIGN must name principal auth"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi '≥ ?2|>= ?2|replicas.*2|상시' "$DESIGN" || fail "DESIGN must require always-on ≥2"
grep -Eqi 'MQT|scale-to-zero|Fission' "$DESIGN" || fail "DESIGN must forbid MQT/scale-to-zero for Gateway"
grep -Eqi '와일드카드|wildcard' "$DESIGN" || fail "DESIGN must forbid stream wildcards"

# Wire doc
grep -q 'UUIDv7' "$DOCS" || fail "docs must require UUIDv7 run_id"
grep -q '/v1/agent/invoke' "$DOCS" || fail "docs must name submit path"
grep -q '/v1/runs/' "$DOCS" || fail "docs must name SSE/WS paths"
grep -Eqi '403|principal_forbidden' "$DOCS" || fail "docs must document 403 principal gate"
grep -Eqi '와일드카드|wildcard' "$DOCS" || fail "docs must forbid stream wildcards"
grep -Eqi 'Fair Queue|Token Bucket|max_inflight' "$DOCS" || fail "docs must list Fair Queue as Non-goal/out of scope"

HANDLER="$GW_DIR/gateway.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

# Source: no PG / pooler
if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" "$HANDLER"; then
  fail "gateway source must not use pg / set_config / AURA_DATABASE_HOST / .query("
fi
grep -q 'issueRunId' "$HANDLER" || fail "gateway must implement issueRunId"
grep -q 'openStreamBridge' "$HANDLER" || fail "gateway must implement openStreamBridge"
grep -q 'authorizeWs' "$HANDLER" || fail "gateway must implement authorizeWs"
grep -q 'formatSseFrame' "$HANDLER" || fail "gateway must implement formatSseFrame"
grep -Eq 'stream_wildcard|wildcard' "$HANDLER" || fail "gateway must reject stream wildcards"

node "$GW_DIR/gateway.selftest.js" || fail "gateway.selftest.js failed"

# Manifests — Deployment ≥2, no MQT
DEP="$K8S_DIR/deployment.yaml"
SVC="$K8S_DIR/service.yaml"
KUST="$K8S_DIR/kustomization.yaml"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$SVC" ]] || fail "missing $SVC"
[[ -f "$KUST" ]] || fail "missing $KUST"

grep -q 'kind: Deployment' "$DEP" || fail "deployment.yaml must be Deployment"
grep -Eq 'replicas:[[:space:]]*[2-9]' "$DEP" || fail "deployment replicas must be ≥ 2"
if grep -Eqi 'MessageQueueTrigger|mqtkind|ScaledObject' "$DEP" "$KUST" "$SVC"; then
  fail "Gateway must not use MessageQueueTrigger / ScaledObject"
fi
grep -q 'aura-gateway' "$DEP" || fail "deployment must name aura-gateway"
grep -q 'kind: Service' "$SVC" || fail "service.yaml must be Service"

# ROADMAP checkbox
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*Gateway:.*run_id' "$ROADMAP" \
  || fail "ROADMAP M3 Gateway run_id/SSE checkbox must be [x]"

ok "gateway run_id + SSE/WS + principal auth"
echo "check-gateway-sse-ws: PASS"
