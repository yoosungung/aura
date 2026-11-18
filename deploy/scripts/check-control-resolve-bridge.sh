#!/usr/bin/env bash
# M3 static gate: aura.rpc.control.resolve bridge — Warm MinScale≥2 + Core RR replicas≥2, no MQT.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/control/DESIGN.md"
DOCS="$ROOT/deploy/docs/control-resolve-bridge.md"
RESOLVE_DOC="$ROOT/deploy/docs/svc-control-resolve.md"
SVC_DIR="$ROOT/services/control"
K8S_DIR="$ROOT/deploy/k8s/control-resolve"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$RESOLVE_DOC" ]] || fail "missing $RESOLVE_DOC"
[[ -d "$SVC_DIR" ]] || fail "missing $SVC_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN — bridge subject + Warm + Pooler pointer + Non-goals
grep -q 'aura.rpc.control.resolve' "$DESIGN" || fail "DESIGN must name aura.rpc.control.resolve"
grep -Eqi 'MinScale|minReplicas|≥ 2|>= 2' "$DESIGN" || fail "DESIGN must require minReplicas/MinScale ≥ 2"
grep -Eqi 'queue-group|queue group|aura-control-resolve' "$DESIGN" || fail "DESIGN must name queue-group"
grep -Eqi 'MQT|MessageQueueTrigger' "$DESIGN" || fail "DESIGN must mention MQT absence"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q 'aura-pg-pooler' "$DESIGN" || fail "DESIGN must keep Pooler contract (aura-pg-pooler)"
grep -Eq "set_config\('app\.tenant_id'" "$DESIGN" || fail "DESIGN must keep set_config tenant GUC contract"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'control-resolve-bridge|bridge\.js' "$DESIGN" || fail "DESIGN must point at bridge doc/handler"

# Wire doc
grep -q 'aura.rpc.control.resolve' "$DOCS" || fail "docs must name aura.rpc.control.resolve"
grep -q 'aura-control-resolve' "$DOCS" || fail "docs must name queue-group aura-control-resolve"
grep -Eqi 'MinScale|minReplicas|≥ 2|>= 2' "$DOCS" || fail "docs must state minReplicas≥2"
grep -Eqi 'Non-goals' "$DOCS" || fail "docs must state Non-goals"
grep -Eqi 'MQT|MessageQueueTrigger|JetStream' "$DOCS" || fail "docs must forbid MQT/JetStream scaler"
grep -q 'control.resolve.done' "$DOCS" || fail "docs must name control.resolve.done"
grep -Eqi 'svc-control-resolve\.md' "$DOCS" || fail "docs must link svc-control-resolve.md"

BRIDGE="$SVC_DIR/bridge.js"
[[ -f "$BRIDGE" ]] || fail "missing $BRIDGE"
grep -q 'aura.rpc.control.resolve' "$BRIDGE" || fail "bridge must name aura.rpc.control.resolve"
grep -q 'control.resolve.done' "$BRIDGE" || fail "bridge must emit control.resolve.done"
grep -Eq 'validateResolveRequest|buildResolveResponse' "$BRIDGE" || fail "bridge must use resolve helpers"
grep -Eqi 'mode.*stub|stub' "$BRIDGE" || fail "bridge must support stub mode"

if grep -Eq "require\(['\"]pg['\"]\)|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" "$BRIDGE"; then
  fail "bridge.js must not hard-wire pg client (injectable only; live Pooler = Non-goal this slice)"
fi

node "$SVC_DIR/bridge.selftest.js" || fail "bridge.selftest.js failed"
node "$SVC_DIR/resolve.selftest.js" || fail "resolve.selftest.js failed"

# Manifests — sync Warm + Core RR, no JetStream MQT
FN="$K8S_DIR/function.yaml"
DEP="$K8S_DIR/rpc-responder.yaml"
PKG="$K8S_DIR/package.yaml"
SKEL="$K8S_DIR/skeleton.js"
KUST="$K8S_DIR/kustomization.yaml"
ENVF="$K8S_DIR/environment.yaml"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$SKEL" ]] || fail "missing $SKEL"
[[ -f "$KUST" ]] || fail "missing $KUST"
[[ -f "$ENVF" ]] || fail "missing $ENVF"

if grep -REq 'kind:[[:space:]]*MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$K8S_DIR"/*.yaml; then
  fail "control-resolve must not include MessageQueueTrigger or ScaledObject"
fi
grep -q 'rpc-responder.yaml' "$KUST" || fail "kustomization must include rpc-responder.yaml"
if grep -E '^[[:space:]]*-[[:space:]]*mqt\.yaml' "$KUST"; then
  fail "kustomization must not list mqt.yaml"
fi

grep -q 'aura.runtime/class: sync' "$FN" || fail "function must label aura.runtime/class=sync"
grep -Eq 'ExecutorType:[[:space:]]*newdeploy' "$FN" || fail "function ExecutorType must be newdeploy"
grep -Eq 'MinScale:[[:space:]]*[2-9]|MinScale:[[:space:]]*[1-9][0-9]' "$FN" \
  || fail "function MinScale must be >= 2"

grep -q 'name: aura-control-resolve-rr' "$DEP" || fail "deployment must be aura-control-resolve-rr"
grep -q 'aura.runtime/class: sync' "$DEP" || fail "deployment must label sync"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$DEP" \
  || fail "deployment replicas must be >= 2"
grep -q 'aura.rpc.control.resolve' "$DEP" || fail "deployment must subscribe aura.rpc.control.resolve"
grep -q 'aura-control-resolve' "$DEP" || fail "deployment must use queue-group aura-control-resolve"
grep -q 'control.resolve.done' "$DEP" || fail "deployment reply must mark control.resolve.done"
grep -Eq 'nats reply|-q' "$DEP" || fail "deployment must nats reply -q (queue-group)"

python3 - "$PKG" "$SKEL" <<'PY' || fail "package.yaml literal != skeleton.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches skeleton.js")
PY

# ARCHITECTURE + ROADMAP + AGENTS
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
[[ -f "$AGENTS" ]] || fail "missing $AGENTS"
grep -Eq 'control-resolve-bridge\.md' "$ARCH" || fail "ARCHITECTURE must link control-resolve-bridge.md"
grep -Eq '\[x\].*`aura\.rpc\.control\.resolve`' "$ROADMAP" \
  || fail "ROADMAP control.resolve bridge checkbox must be [x]"
grep -Eq 'control-resolve' "$AGENTS" || fail "AGENTS.md must list deploy/k8s/control-resolve"

ok "control.resolve bridge DESIGN + Warm RPC + no MQT"
echo "check-control-resolve-bridge: PASS"
