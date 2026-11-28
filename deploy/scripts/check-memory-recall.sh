#!/usr/bin/env bash
# Recall hybrid RRF docs + Rust HTTP Deployment (live PG SQL = follow-up).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory/DESIGN.md"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
LIB="$ROOT/services/memory/src/lib.rs"
K8S_DIR="$ROOT/deploy/k8s/memory-recall"
BRIDGE_DEP="$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$HANDLERS" ]] || fail "missing handlers.rs"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q 'aura.rpc.memory.recall' "$DESIGN" || fail "DESIGN must name aura.rpc.memory.recall"
grep -Eqi 'hybrid RRF|hybrid_rrf|RRF' "$DESIGN" || fail "DESIGN must document hybrid RRF"
grep -Eqi 'iterative_scan' "$DESIGN" || fail "DESIGN must require iterative_scan"
grep -q 'RECALL_RPC' "$LIB" || fail "lib must define RECALL_RPC"
grep -q 'handle_recall_request' "$HANDLERS" || fail "handlers must include recall"
grep -q 'hybrid_rrf' "$HANDLERS" || fail "recall stub must emit hybrid_rrf"
[[ ! -f "$ROOT/services/memory/recall/handler.js" ]] || fail "Node recall handler must be removed"

(cd "$ROOT" && cargo test -p aura-memory --offline --lib) || fail "aura-memory lib tests failed"

DEP="$K8S_DIR/deployment.yaml"
[[ -f "$DEP" ]] || fail "missing deployment.yaml"
grep -q 'aura/memory-recall' "$DEP" || fail "deployment image aura/memory-recall"
grep -q 'replicas: 1' "$DEP" || fail "local replicas must be 1"
[[ -f "$BRIDGE_DEP" ]] || fail "missing nats-rpc-bridge deployment"
if grep -REq 'kind:[[:space:]]*MessageQueueTrigger' "$K8S_DIR"/*.yaml 2>/dev/null; then
  fail "memory-recall must not include MessageQueueTrigger"
fi

ok "recall Rust HTTP Deployment + hybrid_rrf wire"
echo "check-memory-recall: PASS"
