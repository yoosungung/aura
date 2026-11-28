#!/usr/bin/env bash
# Gateway run_id + SSE/WS + principal — Rust Deployment (no Node).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/gateway/DESIGN.md"
DOCS="$ROOT/deploy/docs/gateway-sse-ws.md"
E2E_DOC="$ROOT/deploy/docs/gateway-agent-invoke-e2e.md"
SMOKE="$ROOT/deploy/scripts/smoke-gateway-agent-invoke.sh"
SMOKE_INNER="$ROOT/deploy/scripts/smoke-gateway-agent-invoke-inner.sh"
GW_DIR="$ROOT/services/gateway"
LIB="$GW_DIR/src/lib.rs"
K8S_DIR="$ROOT/deploy/k8s/gateway"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$LIB" ]] || fail "missing gateway lib.rs"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"
[[ ! -d "$GW_DIR/js" ]] || fail "gateway/js must be removed"

grep -q 'run_id' "$DESIGN" || fail "DESIGN must name run_id"
grep -q 'aura.stream.' "$DESIGN" || fail "DESIGN must name aura.stream.<run_id>"
grep -q 'aura.tasks.agent.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.agent.invoke"
grep -Eqi 'SSE|WebSocket|WS' "$DESIGN" || fail "DESIGN must name SSE/WS"
grep -Eqi 'principal' "$DESIGN" || fail "DESIGN must name principal auth"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'MQT|scale-to-zero|Fission' "$DESIGN" || fail "DESIGN must forbid MQT/scale-to-zero for Gateway"
grep -Eqi '와일드카드|wildcard' "$DESIGN" || fail "DESIGN must forbid stream wildcards"

grep -q 'UUIDv7' "$DOCS" || fail "docs must require UUIDv7 run_id"
grep -q '/v1/agent/invoke' "$DOCS" || fail "docs must name submit path"
grep -q '/v1/runs/' "$DOCS" || fail "docs must name SSE/WS paths"
grep -Eqi '403|principal_forbidden' "$DOCS" || fail "docs must document 403 principal gate"

if grep -Eqi 'sqlx|postgres|AURA_DATABASE|set_config' "$LIB" "$GW_DIR/src/rate_limit.rs"; then
  fail "gateway rust must not use pg / set_config"
fi
grep -q 'issue_run_id' "$LIB" || fail "gateway must implement issue_run_id"
grep -q 'open_stream_bridge' "$LIB" || fail "gateway must implement open_stream_bridge"
grep -q 'authorize_ws' "$LIB" || fail "gateway must implement authorize_ws"
grep -q 'format_sse_frame' "$LIB" || fail "gateway must implement format_sse_frame"
grep -q 'stream_wildcard' "$LIB" || fail "gateway must reject stream wildcards"

(cd "$ROOT" && cargo test -p aura-gateway --offline) || fail "aura-gateway tests failed"

DEP="$K8S_DIR/deployment.yaml"
SVC="$K8S_DIR/service.yaml"
KUST="$K8S_DIR/kustomization.yaml"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$SVC" ]] || fail "missing $SVC"
[[ -f "$KUST" ]] || fail "missing $KUST"

grep -q 'kind: Deployment' "$DEP" || fail "deployment.yaml must be Deployment"
grep -Eq 'replicas:[[:space:]]*[1-9]' "$DEP" || fail "deployment replicas must be ≥ 1"
if grep -Eqi 'MessageQueueTrigger|ScaledObject' "$DEP" "$KUST" "$SVC"; then
  fail "Gateway must not use MessageQueueTrigger / ScaledObject"
fi
grep -q 'aura-gateway' "$DEP" || fail "deployment must name aura-gateway"
grep -q 'image: aura/gateway:local' "$DEP" || fail "gateway image must be aura/gateway:local"
[[ -f "$GW_DIR/Dockerfile" ]] || fail "missing gateway Dockerfile"
grep -q 'dev.orbstack.icon=' "$GW_DIR/Dockerfile" || fail "gateway image must set dev.orbstack.icon"
grep -Eq 'aura/gateway' "$DESIGN" || fail "DESIGN must name aura/gateway image"

grep -Eq '\[x\].*Gateway:.*run_id' "$ROADMAP" \
  || fail "ROADMAP M3 Gateway run_id/SSE checkbox must be [x]"

[[ -f "$E2E_DOC" ]] || fail "missing $E2E_DOC"
[[ -f "$SMOKE" ]] || fail "missing $SMOKE"
[[ -f "$SMOKE_INNER" ]] || fail "missing $SMOKE_INNER"
grep -q 'aura-gateway.aura.svc.cluster.local:8080' "$E2E_DOC" \
  || fail "e2e doc must pin in-cluster Gateway DNS"
grep -Eqi 'port-forward 금지|port-forward.*금지' "$E2E_DOC" \
  || fail "e2e doc must forbid port-forward"
grep -q 'gateway-agent-invoke-e2e' "$DOCS" \
  || fail "gateway-sse-ws.md must link e2e doc"
grep -q 'smoke-gateway-agent-invoke' "$DESIGN" \
  || fail "DESIGN Commands must name smoke-gateway-agent-invoke"
SMOKE_GATEWAY_AGENT_INVOKE_STATIC=1 bash "$SMOKE" \
  || fail "static smoke-gateway-agent-invoke failed"

ok "gateway run_id + SSE/WS + principal auth (Rust)"
echo "check-gateway-sse-ws: PASS"
