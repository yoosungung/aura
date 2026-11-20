#!/usr/bin/env bash
# M3.6 static gate: task-bridge routing + no initContainer npm + docs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$ROOT/services/nats-task-bridge/bridge.js" ]] || fail "missing task-bridge"
[[ -f "$ROOT/services/nats-task-bridge/Dockerfile" ]] || fail "missing Dockerfile"
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

node "$ROOT/services/nats-task-bridge/bridge.selftest.js" || fail "task-bridge selftest"
node "$ROOT/services/nats-rpc-bridge/bridge.selftest.js" || fail "rpc-bridge selftest"

echo "check-nats-task-bridge: PASS"
