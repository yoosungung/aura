#!/usr/bin/env bash
# M3 static gate: mcp_invoke dual — async MQT + sync RPC Warm (minReplicas≥2), PG-forbidden.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/mcp-invoke/DESIGN.md"
DOCS="$ROOT/deploy/docs/mcp-invoke-dual.md"
SVC_DIR="$ROOT/services/mcp-invoke"
K8S_MQT="$ROOT/deploy/k8s/mcp-invoke"
K8S_RPC="$ROOT/deploy/k8s/mcp-invoke-rpc"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -d "$SVC_DIR" ]] || fail "missing $SVC_DIR"
[[ -d "$K8S_MQT" ]] || fail "missing $K8S_MQT"
[[ -d "$K8S_RPC" ]] || fail "missing $K8S_RPC"

# DESIGN — async + sync + PG forbid
grep -q 'aura.tasks.mcp.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.mcp.invoke"
grep -q 'aura.events.mcp.invoke.done' "$DESIGN" || fail "DESIGN must name mcp.invoke.done"
grep -q 'aura.events.mcp.invoke.error' "$DESIGN" || fail "DESIGN must name mcp.invoke.error"
grep -q 'aura.rpc.mcp.tool' "$DESIGN" || fail "DESIGN must name aura.rpc.mcp.tool"
grep -Eqi 'MinScale|minReplicas|≥ 2|>= 2' "$DESIGN" || fail "DESIGN must require minReplicas/MinScale ≥ 2 for RPC"
grep -Eqi 'PG|PostgreSQL|Zero Direct Write' "$DESIGN" || fail "DESIGN must mention PG / Zero Direct Write"
grep -Eqi '금지|forbid|forbidden|no PG|PG 금지' "$DESIGN" || fail "DESIGN must forbid PG"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'minReplicaCount.*0|scale-to-zero' "$DESIGN" || fail "DESIGN must state MQT scale-to-zero"

# Wire doc
grep -q 'aura.tasks.mcp.invoke' "$DOCS" || fail "docs must name aura.tasks.mcp.invoke"
grep -q 'aura.rpc.mcp.tool' "$DOCS" || fail "docs must name aura.rpc.mcp.tool"
grep -q 'aura_mcp_invoke' "$DOCS" || fail "docs must name consumer aura_mcp_invoke"
grep -Eqi 'MinScale|minReplicas|≥ 2|>= 2' "$DOCS" || fail "docs must state RPC minReplicas≥2"
grep -Eqi 'Non-goals' "$DOCS" || fail "docs must state Non-goals"
grep -Eqi 'Streamable HTTP|MCP 프로토콜' "$DOCS" || fail "docs must note internal NATS RR / external HTTP non-goal"

HANDLER="$SVC_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" \
  "$HANDLER" "$K8S_MQT/invoke.js"; then
  fail "mcp-invoke source must not use pg / set_config / AURA_DATABASE_HOST / .query("
fi

grep -q 'mcp.invoke.done' "$HANDLER" || fail "handler must emit mcp.invoke.done"
grep -q 'mcp.tool.done' "$HANDLER" || fail "handler must emit mcp.tool.done"
grep -q 'aura.rpc.mcp.tool' "$HANDLER" || fail "handler must name aura.rpc.mcp.tool"

node "$SVC_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests
MQT="$K8S_MQT/mqt.yaml"
FN_MQT="$K8S_MQT/function.yaml"
PKG_MQT="$K8S_MQT/package.yaml"
INVOKE_JS="$K8S_MQT/invoke.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN_MQT" ]] || fail "missing $FN_MQT"
[[ -f "$PKG_MQT" ]] || fail "missing $PKG_MQT"
[[ -f "$INVOKE_JS" ]] || fail "missing $INVOKE_JS"

python3 - "$PKG_MQT" "$INVOKE_JS" <<'PY' || fail "mcp-invoke package.yaml literal != invoke.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: mcp-invoke package literal matches invoke.js")
PY

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.mcp.invoke' "$MQT" || fail "mqt topic must be aura.tasks.mcp.invoke"
grep -q 'aura.events.mcp.invoke.done' "$MQT" || fail "mqt respTopic must be aura.events.mcp.invoke.done"
grep -q 'aura.events.mcp.invoke.error' "$MQT" || fail "mqt errorTopic must be aura.events.mcp.invoke.error"
grep -q 'aura_mcp_invoke' "$MQT" || fail "mqt consumer must be aura_mcp_invoke"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"

# RPC manifests — Warm + Core RR, no MQT
FN_RPC="$K8S_RPC/function.yaml"
DEP="$K8S_RPC/rpc-responder.yaml"
PKG_RPC="$K8S_RPC/package.yaml"
SKEL="$K8S_RPC/skeleton.js"
KUST_RPC="$K8S_RPC/kustomization.yaml"
[[ -f "$FN_RPC" ]] || fail "missing $FN_RPC"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$PKG_RPC" ]] || fail "missing $PKG_RPC"
[[ -f "$SKEL" ]] || fail "missing $SKEL"
[[ -f "$KUST_RPC" ]] || fail "missing $KUST_RPC"

if grep -REq 'kind:[[:space:]]*MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$K8S_RPC"/*.yaml; then
  fail "mcp-invoke-rpc must not include MessageQueueTrigger or ScaledObject"
fi
grep -q 'rpc-responder.yaml' "$KUST_RPC" || fail "kustomization must include rpc-responder.yaml"

grep -q 'aura.runtime/class: sync' "$FN_RPC" || fail "rpc function must label sync"
grep -Eq 'ExecutorType:[[:space:]]*newdeploy' "$FN_RPC" || fail "rpc function ExecutorType must be newdeploy"
grep -Eq 'MinScale:[[:space:]]*[2-9]|MinScale:[[:space:]]*[1-9][0-9]' "$FN_RPC" \
  || fail "rpc function MinScale must be >= 2"

grep -q 'name: aura-mcp-invoke-rr' "$DEP" || fail "deployment must be aura-mcp-invoke-rr"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$DEP" \
  || fail "deployment replicas must be >= 2"
grep -q 'aura.rpc.mcp.tool' "$DEP" || fail "deployment must subscribe aura.rpc.mcp.tool"
grep -q 'aura-mcp-invoke' "$DEP" || fail "deployment must use queue-group aura-mcp-invoke"
grep -q 'mcp.tool.done' "$DEP" || fail "deployment reply must mark mcp.tool.done"

python3 - "$PKG_RPC" "$SKEL" <<'PY' || fail "mcp-invoke-rpc package.yaml literal != skeleton.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: mcp-invoke-rpc package literal matches skeleton.js")
PY

# ARCHITECTURE + ROADMAP
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq 'mcp-invoke-dual\.md' "$ARCH" || fail "ARCHITECTURE must link mcp-invoke-dual.md"
grep -Eq '\[x\].*`mcp_invoke`' "$ROADMAP" \
  || fail "ROADMAP mcp_invoke dual checkbox must be [x]"

# agent_invoke DESIGN should point at mcp dual (no longer non-goal)
AGENT_DESIGN="$ROOT/services/agent-invoke/DESIGN.md"
grep -Eq 'mcp-invoke' "$AGENT_DESIGN" || fail "agent-invoke DESIGN must reference mcp-invoke dual"

ok "mcp_invoke dual DESIGN + MQT + RPC Warm + PG-forbidden"
echo "check-mcp-invoke-dual: PASS"