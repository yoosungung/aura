#!/usr/bin/env bash
# M3 static gate: agent_invoke MQT + stream frame contract + selftest.
# No cluster required. Exit 0 only when invariants hold. Ticket 54a06a7d.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/agent-invoke/DESIGN.md"
DOC="$ROOT/deploy/docs/agent-invoke-mqt.md"
INVOKE_DIR="$ROOT/services/agent-invoke"
K8S_DIR="$ROOT/deploy/k8s/agent-invoke"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -d "$INVOKE_DIR" ]] || fail "missing $INVOKE_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"

# DESIGN contracts
grep -q 'aura.tasks.agent.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.agent.invoke"
grep -q 'aura.events.agent.invoke.done' "$DESIGN" || fail "DESIGN must name invoke.done"
grep -q 'aura.events.agent.invoke.error' "$DESIGN" || fail "DESIGN must name invoke.error"
grep -q 'aura.stream.' "$DESIGN" || fail "DESIGN must name aura.stream"
grep -Eqi 'minReplicaCount.*0|scale-to-zero' "$DESIGN" || fail "DESIGN must state scale-to-zero"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'PG|금지|Zero Direct Write' "$DESIGN" || fail "DESIGN must forbid PG / Zero Direct Write"

# Doc: frames + RPC order + V3.1
grep -q 'aura.stream.<run_id>' "$DOC" || fail "doc must name aura.stream.<run_id>"
grep -q 'run.started' "$DOC" || fail "doc must lock run.started"
grep -q 'token' "$DOC" || fail "doc must lock token frame"
grep -q 'tool.started' "$DOC" || fail "doc must lock tool.started"
grep -q 'tool.finished' "$DOC" || fail "doc must lock tool.finished"
grep -q 'run.completed' "$DOC" || fail "doc must lock run.completed"
grep -Eqi 'aura\.rpc\.control\.resolve' "$DOC" || fail "doc must name resolve RPC"
grep -Eqi 'aura\.rpc\.memory\.recall' "$DOC" || fail "doc must name recall RPC"
grep -Eqi 'aura\.rpc\.mcp\.tool' "$DOC" || fail "doc must name mcp.tool RPC"
grep -Eqi 'V3\.1|done 이전' "$DOC" || fail "doc must state V3.1 token-before-done"
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'JetStream|유실' "$DOC" || fail "doc must forbid JetStream tokens / state lossy"

HANDLER="$INVOKE_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

# Source: no PG / pooler / set_config
if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" \
  "$HANDLER" "$K8S_DIR/invoke.js"; then
  fail "agent-invoke source must not use pg / set_config / AURA_DATABASE_HOST / .query("
fi

# Frame types present in handler
grep -q 'run.started' "$HANDLER" || fail "handler must emit run.started"
grep -q "type: 'token'" "$HANDLER" || fail "handler must emit token"
grep -q 'tool.started' "$HANDLER" || fail "handler must emit tool.started"
grep -q 'run.completed' "$HANDLER" || fail "handler must emit run.completed"
grep -q 'agent.invoke.done' "$HANDLER" || fail "handler must emit agent.invoke.done"

# Unit self-check
node "$INVOKE_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests
MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
INVOKE_JS="$K8S_DIR/invoke.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$INVOKE_JS" ]] || fail "missing $INVOKE_JS"

python3 - "$PKG" "$INVOKE_JS" <<'PY' || fail "package.yaml literal != invoke.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches invoke.js")
PY

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.agent.invoke' "$MQT" || fail "mqt topic must be aura.tasks.agent.invoke"
grep -q 'aura.events.agent.invoke.done' "$MQT" || fail "mqt respTopic must be invoke.done"
grep -q 'aura.events.agent.invoke.error' "$MQT" || fail "mqt errorTopic must be invoke.error"
grep -q 'aura_agent_invoke' "$MQT" || fail "mqt consumer must be aura_agent_invoke"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

# ARCHITECTURE + ROADMAP
grep -Eq 'agent-invoke-mqt\.md' "$ARCH" || fail "ARCHITECTURE must link agent-invoke-mqt.md"
grep -Eq '\[x\].*`agent_invoke` MQT' "$ROADMAP" \
  || fail "ROADMAP M3 agent_invoke checkbox must be [x]"
grep -Eq '\[x\].*프레임 계약 확정' "$ROADMAP" \
  || fail "ROADMAP M3 frame-contract checkbox must be [x]"

ok "agent_invoke DESIGN + MQT + stream frames + selftest"
echo "check-agent-invoke: PASS"
