#!/usr/bin/env bash
# M3 static gate: agent_invoke DESIGN + MQT + stream frames + PG-forbidden selftest.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/agent-invoke/DESIGN.md"
DOCS="$ROOT/deploy/docs/agent-invoke-mqt.md"
INVOKE_DIR="$ROOT/services/agent-invoke"
K8S_DIR="$ROOT/deploy/k8s/agent-invoke"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -d "$INVOKE_DIR" ]] || fail "missing $INVOKE_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN contracts
grep -q 'aura.tasks.agent.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.agent.invoke"
grep -q 'aura.events.agent.invoke.done' "$DESIGN" || fail "DESIGN must name invoke.done"
grep -q 'aura.events.agent.invoke.error' "$DESIGN" || fail "DESIGN must name invoke.error"
grep -q 'aura.stream.' "$DESIGN" || fail "DESIGN must name aura.stream.<run_id>"
grep -Eqi 'PG|PostgreSQL|Zero Direct Write' "$DESIGN" || fail "DESIGN must mention PG / Zero Direct Write"
grep -Eqi '금지|forbid|forbidden|no PG|PG 금지' "$DESIGN" || fail "DESIGN must forbid PG"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'minReplicaCount.*0|scale-to-zero' "$DESIGN" || fail "DESIGN must state scale-to-zero / minReplicaCount=0"

# Wire doc: frame types (V3.1 / §3.5)
for t in 'run.started' 'token' 'tool.started' 'tool.finished' 'run.completed'; do
  grep -q "$t" "$DOCS" || fail "agent-invoke-mqt.md must document frame type $t"
done
grep -q 'aura.stream.' "$DOCS" || fail "docs must name aura.stream.<run_id>"
grep -Eqi 'Core|유실|lossy|JetStream.*금지|금지.*JetStream' "$DOCS" \
  || fail "docs must state Core/lossy (not JetStream completion)"

HANDLER="$INVOKE_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

# Source: no PG / pooler / set_config
if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" \
  "$HANDLER" "$K8S_DIR/invoke.js"; then
  fail "invoke source must not use pg / set_config / AURA_DATABASE_HOST / .query("
fi

# Unit self-check
node "$INVOKE_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests (§3.2)
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
grep -q 'aura.events.agent.invoke.done' "$MQT" || fail "mqt respTopic must be aura.events.agent.invoke.done"
grep -q 'aura.events.agent.invoke.error' "$MQT" || fail "mqt errorTopic must be aura.events.agent.invoke.error"
grep -q 'aura_agent_invoke' "$MQT" || fail "mqt consumer must be aura_agent_invoke"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0 (scale-to-zero)"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

# ARCHITECTURE + ROADMAP
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq 'agent-invoke-mqt\.md' "$ARCH" || fail "ARCHITECTURE must link agent-invoke-mqt.md"
grep -Eq '\[x\].*`agent_invoke` MQT' "$ROADMAP" \
  || fail "ROADMAP M3 agent_invoke MQT checkbox must be [x]"
grep -Eq '\[x\].*프레임 계약 확정' "$ROADMAP" \
  || fail "ROADMAP M3 frame-contract checkbox must be [x]"

ok "agent_invoke DESIGN + MQT + stream frames + PG-forbidden"
echo "check-agent-invoke: PASS"
