#!/usr/bin/env bash
# Static gate: memory_capture Rust bin in aura-memory + Deployment image split.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory/DESIGN.md"
MEM="$ROOT/services/memory"
K8S_DIR="$ROOT/deploy/k8s/memory-capture"
APPLY="$ROOT/deploy/scripts/apply-product.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$MEM/src/capture.rs" ]] || fail "missing aura-memory capture.rs"
[[ ! -d "$MEM/src/capture" ]] || fail "src/capture/ dir must be flattened to capture.rs"
[[ ! -d "$MEM/capture" ]] || fail "services/memory/capture/ must be removed (DESIGN merged)"
[[ -f "$MEM/src/bin/aura-memory-capture.rs" ]] || fail "missing aura-memory-capture bin"
[[ -f "$MEM/Dockerfile.capture" ]] || fail "missing Dockerfile.capture"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q 'aura.tasks.memory.capture' "$DESIGN" || fail "DESIGN must name aura.tasks.memory.capture"
grep -q 'aura.events.memory.capture.done' "$DESIGN" || fail "DESIGN must name capture.done"
grep -q 'aura/memory-capture' "$DESIGN" || fail "DESIGN must name aura/memory-capture image"
grep -q '## Capture Deployment' "$DESIGN" || fail "DESIGN must include ## Capture Deployment"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -q 'aura-memory-capture' "$MEM/Cargo.toml" || fail "Cargo.toml must declare aura-memory-capture bin"

(cd "$ROOT" && cargo test -p aura-memory --lib capture --offline) || fail "aura-memory capture tests failed"

DEP="$K8S_DIR/deployment.yaml"
[[ -f "$DEP" ]] || fail "missing $DEP"
grep -q 'aura/memory-capture' "$DEP" || fail "deployment image must be aura/memory-capture"
grep -q 'aura.events.memory.capture.done' "$DEP" || fail "RESP_TOPIC capture.done"
grep -q 'replicas: 1' "$DEP" || fail "deployment replicas must be 1"

grep -q 'memory-capture' "$APPLY" || fail "apply-product must include memory-capture"
if grep -Eq '^\s*memory-store\s*$|^\s*memory-embed\s*$' "$APPLY"; then
  fail "apply-product must not list memory-store or memory-embed"
fi

ok "memory_capture in aura-memory + separate aura/memory-capture image"
echo "check-memory-capture: PASS"
