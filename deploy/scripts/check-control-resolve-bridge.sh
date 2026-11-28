#!/usr/bin/env bash
# control.resolve — Rust Deployment + shared nats-rpc-bridge (no Fission/MQT).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/control/DESIGN.md"
DOCS="$ROOT/deploy/docs/control-resolve-bridge.md"
RESOLVE_DOC="$ROOT/deploy/docs/svc-control-resolve.md"
CTRL="$ROOT/services/control"
K8S_DIR="$ROOT/deploy/k8s/control-resolve"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
AGENTS="$ROOT/AGENTS.md"
BRIDGE_DEP="$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml"
BRIDGE_RS="$ROOT/services/nats-rpc-bridge/src/lib.rs"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$RESOLVE_DOC" ]] || fail "missing $RESOLVE_DOC"
[[ -f "$CTRL/src/lib.rs" ]] || fail "missing control Rust lib"
[[ -f "$CTRL/src/bin/aura-control-resolve.rs" ]] || fail "missing aura-control-resolve binary"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"
[[ ! -d "$CTRL/js" ]] || fail "control/js must be removed (Rust-only)"

grep -q 'aura.rpc.control.resolve' "$DESIGN" || fail "DESIGN must name aura.rpc.control.resolve"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q 'aura-pg-pooler' "$DESIGN" || fail "DESIGN must keep Pooler contract"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"

grep -q 'aura.rpc.control.resolve' "$DOCS" || fail "docs must name aura.rpc.control.resolve"
grep -Eq 'nats-rpc-bridge|aura-control-resolve' "$DOCS" || fail "docs must name bridge or resolve service"
grep -q 'control.resolve.done' "$DOCS" || fail "docs must name control.resolve.done"

grep -q 'validate_resolve_request' "$CTRL/src/lib.rs" || fail "control lib must expose validate_resolve_request"
grep -q 'resolve_with_pooler' "$CTRL/src/lib.rs" || fail "control lib must expose resolve_with_pooler"
grep -q 'SET_TENANT_GUC_SQL' "$CTRL/src/lib.rs" || fail "control lib must keep SET_TENANT_GUC_SQL contract"

(cd "$ROOT" && cargo test -p aura-control --lib --offline) || fail "aura-control lib tests failed"

DEP="$K8S_DIR/deployment.yaml"
KUST="$K8S_DIR/kustomization.yaml"
[[ -f "$DEP" ]] || fail "missing deployment.yaml"
[[ -f "$KUST" ]] || fail "missing kustomization.yaml"
grep -q 'aura/control-resolve' "$DEP" || fail "deployment image aura/control-resolve"
grep -q 'replicas: 1' "$DEP" || fail "lab replicas must be 1"
if grep -qE 'function\.yaml|mqt\.yaml|package\.yaml|archive\.zip' "$KUST"; then
  fail "kustomization must not list Fission resources"
fi
if grep -REq 'kind:[[:space:]]*MessageQueueTrigger' "$K8S_DIR"/*.yaml 2>/dev/null; then
  fail "control-resolve must not include MessageQueueTrigger"
fi

[[ -f "$BRIDGE_DEP" ]] || fail "missing nats-rpc-bridge deployment"
[[ -f "$BRIDGE_RS" ]] || fail "missing rpc-bridge lib"
grep -q 'name: aura-nats-rpc-bridge' "$BRIDGE_DEP" || fail "bridge deployment must be aura-nats-rpc-bridge"
grep -q 'aura.rpc.control.resolve' "$BRIDGE_RS" || fail "Rust bridge must map aura.rpc.control.resolve"
grep -q 'aura-control-resolve' "$BRIDGE_RS" || fail "Rust bridge must target aura-control-resolve"

grep -Eq 'control-resolve-bridge\.md' "$ARCH" || fail "ARCHITECTURE must link control-resolve-bridge.md"
grep -Eq '\[x\].*`aura\.rpc\.control\.resolve`' "$ROADMAP" \
  || fail "ROADMAP control.resolve bridge checkbox must be [x]"
grep -Eq 'control-resolve' "$AGENTS" || fail "AGENTS.md must list control-resolve"

ok "control.resolve Rust Deployment + shared NATS bridge + no MQT"
echo "check-control-resolve-bridge: PASS"
