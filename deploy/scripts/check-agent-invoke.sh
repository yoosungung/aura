#!/usr/bin/env bash
# M3.5 static gate: agent_invoke DESIGN + MQT + stream + archive + createAgent selftests.
# PG: memory_* forbidden; agent_checkpoints via checkpoints.js only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/agent-invoke/DESIGN.md"
DOCS="$ROOT/deploy/docs/agent-invoke-mqt.md"
CREATE_DOC="$ROOT/deploy/docs/agent-invoke-create-agent.md"
ARCHIVE_DOC="$ROOT/deploy/docs/fission-node-archive.md"
INVOKE_DIR="$ROOT/services/agent-invoke"
K8S_DIR="$ROOT/deploy/k8s/agent-invoke"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$CREATE_DOC" ]] || fail "missing $CREATE_DOC"
[[ -f "$ARCHIVE_DOC" ]] || fail "missing $ARCHIVE_DOC"
[[ -d "$INVOKE_DIR" ]] || fail "missing $INVOKE_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q 'aura.tasks.agent.invoke' "$DESIGN" || fail "DESIGN must name aura.tasks.agent.invoke"
grep -q 'aura.events.agent.invoke.done' "$DESIGN" || fail "DESIGN must name invoke.done"
grep -q 'aura.events.agent.invoke.error' "$DESIGN" || fail "DESIGN must name invoke.error"
grep -q 'aura.stream.' "$DESIGN" || fail "DESIGN must name aura.stream.<run_id>"
grep -Eqi 'PG|PostgreSQL|Zero Direct Write' "$DESIGN" || fail "DESIGN must mention PG / Zero Direct Write"
grep -Eqi 'agent_checkpoints|memory_\*' "$DESIGN" || fail "DESIGN must scope PG (memory forbid / checkpoints)"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'minReplicaCount.*0|scale-to-zero' "$DESIGN" || fail "DESIGN must state scale-to-zero / minReplicaCount=0"
grep -Eqi 'archive|createAgent' "$DESIGN" || fail "DESIGN must mention archive / createAgent"
grep -Eqi 'mcp-invoke' "$DESIGN" || fail "DESIGN must reference mcp-invoke"

for t in 'run.started' 'token' 'tool.started' 'tool.finished' 'run.completed'; do
  grep -q "$t" "$DOCS" || fail "agent-invoke-mqt.md must document frame type $t"
done

HANDLER="$INVOKE_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
[[ -f "$INVOKE_DIR/run-turn-create-agent.js" ]] || fail "missing run-turn-create-agent.js"
[[ -f "$INVOKE_DIR/llm-gateway-model.js" ]] || fail "missing llm-gateway-model.js"
[[ -f "$INVOKE_DIR/checkpoints.js" ]] || fail "missing checkpoints.js"

# memory_* / direct pooler strings forbidden in handler shell
if grep -Eq 'memory_items|memory_embeddings|memory_nodes|memory_edges|memory_audit' \
  "$HANDLER" "$INVOKE_DIR/run-turn-create-agent.js" "$INVOKE_DIR/llm-gateway-model.js"; then
  fail "agent-invoke must not touch memory_* tables"
fi
if grep -Eq "require\(['\"]pg['\"]\)" "$HANDLER"; then
  fail "handler.js must not require pg — use checkpoints.js"
fi
# checkpoints.js may use pg + set_config(..., true) for agent_checkpoints only
if [[ -f "$INVOKE_DIR/checkpoints.js" ]]; then
  if grep -Eq 'memory_items|memory_embeddings|memory_nodes|memory_edges|memory_audit' \
    "$INVOKE_DIR/checkpoints.js"; then
    fail "checkpoints.js must not touch memory_*"
  fi
  if grep -Eq "set_config\([^)]*,\s*false\s*\)" "$INVOKE_DIR/checkpoints.js"; then
    fail "checkpoints.js must use set_config(..., true) only"
  fi
fi

node "$INVOKE_DIR/handler.selftest.js" || fail "handler.selftest.js failed"
node "$INVOKE_DIR/run-turn-create-agent.selftest.js" || fail "run-turn-create-agent.selftest.js failed"
node "$INVOKE_DIR/checkpoints.selftest.js" || fail "checkpoints.selftest.js failed"

MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
BUILD="$ROOT/deploy/scripts/build-agent-invoke-archive.sh"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$BUILD" ]] || fail "missing $BUILD"

grep -Eq 'type:[[:space:]]*archive' "$PKG" || fail "package.yaml must use type: archive"
if grep -Eq 'type:[[:space:]]*literal' "$PKG"; then
  fail "package.yaml must not use type: literal"
fi
grep -q 'build-agent-invoke-archive' "$PKG" || fail "package.yaml must cite build-agent-invoke-archive"

bash "$BUILD" || fail "build-agent-invoke-archive.sh failed"
[[ -f "$K8S_DIR/archive.zip" ]] || fail "missing archive.zip after build"

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.agent.invoke' "$MQT" || fail "mqt topic must be aura.tasks.agent.invoke"
grep -q 'aura.events.agent.invoke.done' "$MQT" || fail "mqt respTopic must be aura.events.agent.invoke.done"
grep -q 'aura.events.agent.invoke.error' "$MQT" || fail "mqt errorTopic must be aura.events.agent.invoke.error"
grep -q 'aura_agent_invoke' "$MQT" || fail "mqt consumer must be aura_agent_invoke"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0 (scale-to-zero)"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq 'agent-invoke-mqt\.md' "$ARCH" || fail "ARCHITECTURE must link agent-invoke-mqt.md"
grep -Eq '\[x\].*`agent_invoke` MQT' "$ROADMAP" \
  || fail "ROADMAP M3 agent_invoke MQT checkbox must be [x]"
grep -Eq 'M3\.5|createAgent|archive' "$ROADMAP" || fail "ROADMAP must mention M3.5 / createAgent / archive"

ok "agent_invoke DESIGN + MQT + archive + createAgent + PG scoped"
echo "check-agent-invoke: PASS"
