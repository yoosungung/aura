#!/usr/bin/env bash
# M3.5 static gate: mcp_invoke dual — archive · tools/list · Node RPC worker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/mcp-invoke/DESIGN.md"
DOCS="$ROOT/deploy/docs/mcp-invoke-dual.md"
LIST_DOC="$ROOT/deploy/docs/mcp-tools-list.md"
SVC_DIR="$ROOT/services/mcp-invoke"
K8S_MQT="$ROOT/deploy/k8s/mcp-invoke"
K8S_RPC="$ROOT/deploy/k8s/mcp-invoke-rpc"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$LIST_DOC" ]] || fail "missing $LIST_DOC"
[[ -d "$SVC_DIR" ]] || fail "missing $SVC_DIR"

grep -q 'aura.tasks.mcp.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.mcp.invoke"
grep -q 'aura.events.mcp.invoke.done' "$DESIGN" || fail "DESIGN must name mcp.invoke.done"
grep -q 'aura.events.mcp.invoke.error' "$DESIGN" || fail "DESIGN must name mcp.invoke.error"
grep -q 'aura.rpc.mcp.tool' "$DESIGN" || fail "DESIGN must name aura.rpc.mcp.tool"
grep -Eqi 'MinScale|minReplicas|≥ 2|>= 2' "$DESIGN" || fail "DESIGN must require minReplicas/MinScale ≥ 2 for RPC"
grep -Eqi 'PG|PostgreSQL|Zero Direct Write' "$DESIGN" || fail "DESIGN must mention PG / Zero Direct Write"
grep -Eqi '금지|forbid|forbidden|no PG|PG 금지' "$DESIGN" || fail "DESIGN must forbid PG"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'archive|tools/list|rpc-worker' "$DESIGN" || fail "DESIGN must mention archive / tools/list / rpc-worker"

grep -q 'tools/list' "$LIST_DOC" || fail "mcp-tools-list.md must document tools/list"
grep -q 'action' "$LIST_DOC" || fail "mcp-tools-list.md must document action"

HANDLER="$SVC_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
[[ -f "$SVC_DIR/factory.js" ]] || fail "missing factory.js"
[[ -f "$SVC_DIR/rpc-worker.js" ]] || fail "missing rpc-worker.js"
[[ -f "$SVC_DIR/streamable-http.js" ]] || fail "missing streamable-http.js"

if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" \
  "$HANDLER" "$SVC_DIR/factory.js" "$SVC_DIR/rpc-worker.js"; then
  fail "mcp-invoke source must not use pg / set_config / AURA_DATABASE_HOST / .query("
fi

grep -q 'mcp.invoke.done' "$HANDLER" || fail "handler must emit mcp.invoke.done"
grep -q 'mcp.tool.done' "$HANDLER" || fail "handler must emit mcp.tool.done"
grep -q 'aura.rpc.mcp.tool' "$HANDLER" || fail "handler must name aura.rpc.mcp.tool"
grep -q "action" "$HANDLER" || fail "handler must support action list/call"
grep -q 'tools/list' "$SVC_DIR/streamable-http.js" || fail "streamable-http must support tools/list"

node "$SVC_DIR/handler.selftest.js" || fail "handler.selftest.js failed"
node "$SVC_DIR/streamable-http.selftest.js" || fail "streamable-http.selftest.js failed"

MQT="$K8S_MQT/mqt.yaml"
FN_MQT="$K8S_MQT/function.yaml"
PKG_MQT="$K8S_MQT/package.yaml"
BUILD="$ROOT/deploy/scripts/build-mcp-invoke-archive.sh"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN_MQT" ]] || fail "missing $FN_MQT"
[[ -f "$PKG_MQT" ]] || fail "missing $PKG_MQT"
[[ -f "$BUILD" ]] || fail "missing $BUILD"

grep -Eq 'type:[[:space:]]*archive' "$PKG_MQT" || fail "mcp-invoke package must be archive"
if grep -Eq 'type:[[:space:]]*literal' "$PKG_MQT"; then
  fail "mcp-invoke package must not use literal"
fi

bash "$BUILD" || fail "build-mcp-invoke-archive.sh failed"
[[ -f "$K8S_MQT/archive.zip" ]] || fail "missing mcp-invoke archive.zip"

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.mcp.invoke' "$MQT" || fail "mqt topic must be aura.tasks.mcp.invoke"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"

FN_RPC="$K8S_RPC/function.yaml"
DEP="$K8S_RPC/rpc-responder.yaml"
PKG_RPC="$K8S_RPC/package.yaml"
KUST_RPC="$K8S_RPC/kustomization.yaml"
[[ -f "$FN_RPC" ]] || fail "missing $FN_RPC"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$PKG_RPC" ]] || fail "missing $PKG_RPC"

if grep -REq 'kind:[[:space:]]*MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$K8S_RPC"/*.yaml; then
  fail "mcp-invoke-rpc must not include MessageQueueTrigger or ScaledObject"
fi
if grep -q 'natsio/nats-box' "$DEP"; then
  fail "rpc-responder must not use nats-box stub"
fi
grep -Eq 'image:[[:space:]]*node:' "$DEP" || fail "rpc-responder must use node image"
grep -q 'rpc-worker.js' "$DEP" || fail "rpc-responder must run rpc-worker.js"
grep -q 'aura.rpc.mcp.tool' "$DEP" || fail "deployment must subscribe aura.rpc.mcp.tool"
grep -q 'aura-mcp-invoke' "$DEP" || fail "deployment must use queue-group aura-mcp-invoke"
grep -q 'mcp.tool.done' "$DEP" || fail "deployment must cite mcp.tool.done contract"
grep -Eq 'type:[[:space:]]*archive' "$PKG_RPC" || fail "rpc package must be archive"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$DEP" \
  || fail "deployment replicas must be >= 2"
grep -Eq 'ExecutorType:[[:space:]]*newdeploy' "$FN_RPC" || fail "rpc function ExecutorType must be newdeploy"
grep -Eq 'MinScale:[[:space:]]*[2-9]|MinScale:[[:space:]]*[1-9][0-9]' "$FN_RPC" \
  || fail "rpc function MinScale must be >= 2"

[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq 'mcp-invoke-dual\.md' "$ARCH" || fail "ARCHITECTURE must link mcp-invoke-dual.md"
grep -Eq '\[x\].*`mcp_invoke`' "$ROADMAP" \
  || fail "ROADMAP mcp_invoke dual checkbox must be [x]"

AGENT_DESIGN="$ROOT/services/agent-invoke/DESIGN.md"
grep -Eq 'mcp-invoke' "$AGENT_DESIGN" || fail "agent-invoke DESIGN must reference mcp-invoke dual"

ok "mcp_invoke dual DESIGN + archive + tools/list + Node RPC worker"
echo "check-mcp-invoke-dual: PASS"
