#!/usr/bin/env bash
# M3.6 static gate: task-bridge routing + no initContainer npm + docs (Rust image).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

RPC_RS="$ROOT/services/nats-rpc-bridge/src/lib.rs"
TASK_RS="$ROOT/services/nats-task-bridge/src/lib.rs"
RPC_DF="$ROOT/services/nats-rpc-bridge/Dockerfile"
TASK_DF="$ROOT/services/nats-task-bridge/Dockerfile"

[[ -f "$TASK_RS" ]] || fail "missing task-bridge Rust lib"
[[ -f "$RPC_RS" ]] || fail "missing rpc-bridge Rust lib"
[[ -f "$TASK_DF" ]] || fail "missing task-bridge rs/Dockerfile"
[[ -f "$RPC_DF" ]] || fail "missing rpc-bridge rs/Dockerfile"
grep -q 'dev.orbstack.icon=' "$RPC_DF" || fail "rpc-bridge image must set dev.orbstack.icon"
grep -q 'dev.orbstack.icon=' "$TASK_DF" || fail "task-bridge image must set dev.orbstack.icon"
if grep -Eq 'COPY .*aura-logo\.jpg' "$RPC_DF" "$TASK_DF"; then
  fail "bridge images must not bake the logo file"
fi
[[ -f "$ROOT/deploy/docs/nats-task-bridge.md" ]] || fail "missing nats-task-bridge.md"
[[ -f "$ROOT/deploy/k8s/nats-task-bridge/deployment.yaml" ]] || fail "missing deployment"

grep -q 'aura-agent-invoke-py' "$TASK_RS" || fail "task-bridge must map python agent"
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
grep -q 'InflightGate' "$TASK_RS" || fail "task-bridge must use InflightGate"
grep -q 'tokio::spawn' "$TASK_RS" || fail "task-bridge loop must spawn dispatch"
grep -q 'working' "$TASK_RS" || fail "task-bridge must heartbeat working"
grep -q 'ensure_task_consumer' "$TASK_RS" || fail "task-bridge must ensure consumer AckWait"
[[ -f "$ROOT/deploy/scripts/ensure-task-bridge-consumers.sh" ]] \
  || fail "missing ensure-task-bridge-consumers.sh"
grep -q 'TASK_MAX_INFLIGHT' "$ROOT/services/nats-task-bridge/DESIGN.md" \
  || fail "DESIGN must document TASK_MAX_INFLIGHT"
grep -q 'working()' "$ROOT/services/nats-task-bridge/DESIGN.md" \
  || fail "DESIGN must document working() heartbeat"
grep -Eq 'dispatch|spawn' "$ROOT/deploy/docs/nats-task-bridge.md" \
  || fail "nats-task-bridge.md must document dispatch"
grep -q 'ensure-task-bridge-consumers' "$ROOT/deploy/docs/nats-task-bridge.md" \
  || fail "nats-task-bridge.md must document ensure-task-bridge-consumers"
grep -Eq 'Rust|rs/' "$ROOT/services/nats-task-bridge/DESIGN.md" \
  || fail "task-bridge DESIGN must name Rust as product image"
grep -Eq 'Rust|rs/' "$ROOT/services/nats-rpc-bridge/DESIGN.md" \
  || fail "rpc-bridge DESIGN must name Rust as product image"

(cd "$ROOT" && cargo test -p aura-nats-task-bridge --quiet) || fail "cargo test task-bridge failed"
(cd "$ROOT" && cargo test -p aura-nats-rpc-bridge --quiet) || fail "cargo test rpc-bridge failed"

echo "check-nats-task-bridge: PASS"
