#!/usr/bin/env bash
# M3.6 static gate: task-bridge routing + no initContainer npm + docs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$ROOT/services/nats-task-bridge/bridge.js" ]] || fail "missing task-bridge"
[[ -f "$ROOT/services/nats-task-bridge/Dockerfile" ]] || fail "missing Dockerfile"
grep -q 'dev.orbstack.icon=' "$ROOT/services/nats-rpc-bridge/Dockerfile" \
  || fail "rpc-bridge image must set dev.orbstack.icon"
grep -q 'dev.orbstack.icon=' "$ROOT/services/nats-task-bridge/Dockerfile" \
  || fail "task-bridge image must set dev.orbstack.icon"
if grep -Eq 'COPY .*aura-logo\.jpg' "$ROOT/services/nats-rpc-bridge/Dockerfile" "$ROOT/services/nats-task-bridge/Dockerfile"; then
  fail "bridge images must not bake the logo file"
fi
[[ -f "$ROOT/deploy/docs/nats-task-bridge.md" ]] || fail "missing nats-task-bridge.md"
[[ -f "$ROOT/deploy/k8s/nats-task-bridge/deployment.yaml" ]] || fail "missing deployment"

grep -q 'aura-agent-invoke-py' "$ROOT/services/nats-task-bridge/bridge.js" \
  || fail "task-bridge must map python agent"
if grep -q 'initContainers' "$ROOT/deploy/k8s/nats-task-bridge/deployment.yaml"; then
  fail "task-bridge must not use initContainers"
fi
if grep -q 'initContainers' "$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml"; then
  fail "rpc-bridge must not use initContainers"
fi
grep -q 'aura/nats-rpc-bridge' "$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml" \
  || fail "rpc-bridge must use baked image"

DEP="$ROOT/deploy/k8s/nats-task-bridge/deployment.yaml"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]+' "$DEP" \
  || fail "task-bridge Deployment must set replicas>=2"
grep -q 'TASK_MAX_INFLIGHT' "$DEP" || fail "task-bridge must set TASK_MAX_INFLIGHT"
grep -q 'TASK_ACK_WAIT_MS' "$DEP" || fail "task-bridge must set TASK_ACK_WAIT_MS"
grep -q 'TASK_WORKING_INTERVAL_MS' "$DEP" || fail "task-bridge must set TASK_WORKING_INTERVAL_MS"
grep -q 'createInflightGate' "$ROOT/services/nats-task-bridge/bridge.js" \
  || fail "task-bridge must use createInflightGate"
grep -q 'void dispatchTaskMessage' "$ROOT/services/nats-task-bridge/bridge.js" \
  || fail "task-bridge loop must fire-and-forget dispatchTaskMessage"
grep -q 'startWorkingHeartbeat' "$ROOT/services/nats-task-bridge/bridge.js" \
  || fail "task-bridge must heartbeat msg.working"
grep -q 'ensureTaskConsumer' "$ROOT/services/nats-task-bridge/bridge.js" \
  || fail "task-bridge must ensure consumer AckWait"
[[ -f "$ROOT/deploy/scripts/ensure-task-bridge-consumers.sh" ]] \
  || fail "missing ensure-task-bridge-consumers.sh"
grep -q 'TASK_MAX_INFLIGHT' "$ROOT/services/nats-task-bridge/DESIGN.md" \
  || fail "DESIGN must document TASK_MAX_INFLIGHT"
grep -q 'working()' "$ROOT/services/nats-task-bridge/DESIGN.md" \
  || fail "DESIGN must document working() heartbeat"
grep -q 'dispatchTaskMessage' "$ROOT/deploy/docs/nats-task-bridge.md" \
  || fail "nats-task-bridge.md must document dispatchTaskMessage"
grep -q 'ensure-task-bridge-consumers' "$ROOT/deploy/docs/nats-task-bridge.md" \
  || fail "nats-task-bridge.md must document ensure-task-bridge-consumers"

node "$ROOT/services/nats-task-bridge/bridge.selftest.js" || fail "task-bridge selftest"
node "$ROOT/services/nats-rpc-bridge/bridge.selftest.js" || fail "rpc-bridge selftest"

echo "check-nats-task-bridge: PASS"
