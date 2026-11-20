#!/usr/bin/env bash
# M3 static gate: aura.rpc.control.resolve — poolmgr Function + shared nats-rpc-bridge, no MQT.
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
grep -Eqi 'poolmgr|nats-rpc-bridge|poolsize|replicas ≥ 2|replicas >= 2' "$DESIGN" \
  || fail "DESIGN must require poolmgr/bridge Warm (≥2)"
grep -Eqi 'queue-group|queue group|aura-control-resolve' "$DESIGN" || fail "DESIGN must name queue-group"
grep -Eqi 'MQT|MessageQueueTrigger' "$DESIGN" || fail "DESIGN must mention MQT absence"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q 'aura-pg-pooler' "$DESIGN" || fail "DESIGN must keep Pooler contract (aura-pg-pooler)"
grep -Eq "set_config\('app\.tenant_id'" "$DESIGN" || fail "DESIGN must keep set_config tenant GUC contract"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'control-resolve-bridge|bridge\.js' "$DESIGN" || fail "DESIGN must point at bridge doc/handler"

# Wire doc
grep -q 'aura.rpc.control.resolve' "$DOCS" || fail "docs must name aura.rpc.control.resolve"
grep -Eq 'aura-control-resolve|aura-rpc-bridge|nats-rpc-bridge' "$DOCS" \
  || fail "docs must name resolve Function or shared bridge"
grep -Eqi 'poolmgr|poolsize|replicas ≥ 2|replicas >= 2|bridge' "$DOCS" \
  || fail "docs must state bridge/poolmgr Warm ≥2"
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

# Manifests — sync poolmgr + shared bridge, no JetStream MQT / *-rr
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
KUST="$K8S_DIR/kustomization.yaml"
ARCH_ZIP="$K8S_DIR/archive.zip"
BRIDGE_DEP="$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml"
ENV_SYNC="$ROOT/deploy/k8s/runtime-envs/aura-nodejs-sync.yaml"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$KUST" ]] || fail "missing $KUST"
[[ -f "$ARCH_ZIP" ]] || fail "missing $ARCH_ZIP (run build-control-resolve-archive.sh)"
[[ -f "$BRIDGE_DEP" ]] || fail "missing $BRIDGE_DEP"
[[ -f "$ENV_SYNC" ]] || fail "missing shared sync env $ENV_SYNC"
[[ ! -f "$K8S_DIR/rpc-responder.yaml" ]] || fail "rpc-responder.yaml must be removed (shared bridge)"
grep -q 'name: aura-nodejs-sync' "$FN" || fail "function must use aura-nodejs-sync"
grep -q 'name: aura-nodejs-sync' "$PKG" || fail "package must use aura-nodejs-sync"
grep -Eq 'poolsize:[[:space:]]*[2-9]|poolsize:[[:space:]]*[1-9][0-9]' "$ENV_SYNC" \
  || fail "aura-nodejs-sync poolsize must be >= 2"
if grep -E '^[[:space:]]*-[[:space:]]*environment\.yaml' "$KUST"; then
  fail "kustomization must not list per-service environment.yaml"
fi

if grep -REq 'kind:[[:space:]]*MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$K8S_DIR"/*.yaml; then
  fail "control-resolve must not include MessageQueueTrigger or ScaledObject"
fi
if grep -E '^[[:space:]]*-[[:space:]]*rpc-responder\.yaml' "$KUST"; then
  fail "kustomization must not list rpc-responder.yaml"
fi
if grep -E '^[[:space:]]*-[[:space:]]*mqt\.yaml' "$KUST"; then
  fail "kustomization must not list mqt.yaml"
fi

grep -q 'aura.runtime/class: sync' "$FN" || fail "function must label aura.runtime/class=sync"
grep -Eq 'ExecutorType:[[:space:]]*poolmgr' "$FN" || fail "function ExecutorType must be poolmgr"

grep -q 'name: aura-nats-rpc-bridge' "$BRIDGE_DEP" || fail "bridge deployment must be aura-nats-rpc-bridge"
grep -Eq 'namespace:[[:space:]]*aura' "$BRIDGE_DEP" || fail "bridge deployment must be ns aura"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$BRIDGE_DEP" \
  || fail "bridge replicas must be >= 2"
grep -q 'aura-rpc-bridge' "$BRIDGE_DEP" || fail "bridge must use queue aura-rpc-bridge"
python3 - "$ARCH_ZIP" <<'PY' || fail "archive must include bridge.js + index.js"
import zipfile, sys
names = zipfile.ZipFile(sys.argv[1]).namelist()
assert any(n.endswith("bridge.js") for n in names), names
assert any(n.endswith("index.js") for n in names), names
print("OK: control-resolve archive entries")
PY

# ARCHITECTURE + ROADMAP + AGENTS
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
[[ -f "$AGENTS" ]] || fail "missing $AGENTS"
grep -Eq 'control-resolve-bridge\.md' "$ARCH" || fail "ARCHITECTURE must link control-resolve-bridge.md"
grep -Eq '\[x\].*`aura\.rpc\.control\.resolve`' "$ROADMAP" \
  || fail "ROADMAP control.resolve bridge checkbox must be [x]"
grep -Eq 'control-resolve' "$AGENTS" || fail "AGENTS.md must list deploy/k8s/control-resolve"

ok "control.resolve Function + shared NATS bridge + poolmgr + no MQT"
echo "check-control-resolve-bridge: PASS"
