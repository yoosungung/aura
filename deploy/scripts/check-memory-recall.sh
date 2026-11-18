#!/usr/bin/env bash
# M2 static gate: recall RPC separate deploy — minReplicas≥2, Core queue-group, no MQT.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory/DESIGN.md"
RECALL_DIR="$ROOT/services/memory/recall"
K8S_DIR="$ROOT/deploy/k8s/memory-recall"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -d "$RECALL_DIR" ]] || fail "missing $RECALL_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN contracts
grep -q 'aura.rpc.memory.recall' "$DESIGN" || fail "DESIGN must name aura.rpc.memory.recall"
grep -Eqi 'minReplicas|MinScale|minScale' "$DESIGN" || fail "DESIGN must require minReplicas/MinScale ≥ 2"
grep -Eqi 'queue-group|queue group|queue_group' "$DESIGN" || fail "DESIGN must name Core queue-group"
grep -Eqi 'MQT|MessageQueueTrigger' "$DESIGN" || fail "DESIGN must mention MQT absence"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q 'aura-pg-pooler' "$DESIGN" || fail "DESIGN must keep Pooler contract (aura-pg-pooler)"
grep -Eq "set_config\('app\.tenant_id'" "$DESIGN" || fail "DESIGN must keep set_config tenant GUC contract"
grep -Eqi 'iterative_scan|ef_search' "$DESIGN" || fail "DESIGN must reference iterative_scan/ef_search (sibling RRF)"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"

HANDLER="$RECALL_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
grep -q 'aura.rpc.memory.recall' "$HANDLER" || fail "handler must name aura.rpc.memory.recall"
grep -q 'memory.recall.done' "$HANDLER" || fail "handler must emit memory.recall.done"
grep -Eqi 'stub' "$HANDLER" || fail "handler must mark stub mode (RRF sibling)"

node "$RECALL_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# Manifests — sync Warm + Core RR, no JetStream MQT
FN="$K8S_DIR/function.yaml"
DEP="$K8S_DIR/rpc-responder.yaml"
PKG="$K8S_DIR/package.yaml"
SKEL="$K8S_DIR/skeleton.js"
KUST="$K8S_DIR/kustomization.yaml"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$SKEL" ]] || fail "missing $SKEL"
[[ -f "$KUST" ]] || fail "missing $KUST"

# No MQT / ScaledObject in this kustomization
if grep -REq 'kind:[[:space:]]*MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$K8S_DIR"/*.yaml; then
  fail "memory-recall must not include MessageQueueTrigger or ScaledObject"
fi
grep -q 'rpc-responder.yaml' "$KUST" || fail "kustomization must include rpc-responder.yaml"
# resources: must not list mqt.yaml (comments mentioning MessageQueueTrigger are OK)
if grep -E '^[[:space:]]*-[[:space:]]*mqt\.yaml' "$KUST"; then
  fail "kustomization must not list mqt.yaml"
fi

# Function: newdeploy MinScale≥2, sync class
grep -q 'aura.runtime/class: sync' "$FN" || fail "function must label aura.runtime/class=sync"
grep -Eq 'ExecutorType:[[:space:]]*newdeploy' "$FN" || fail "function ExecutorType must be newdeploy"
grep -Eq 'MinScale:[[:space:]]*[2-9]|MinScale:[[:space:]]*[1-9][0-9]' "$FN" \
  || fail "function MinScale must be >= 2"

# Deployment: replicas≥2, subject + queue-group
grep -q 'name: aura-memory-recall-rr' "$DEP" || fail "deployment must be aura-memory-recall-rr"
grep -q 'aura.runtime/class: sync' "$DEP" || fail "deployment must label sync"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$DEP" \
  || fail "deployment replicas must be >= 2"
grep -q 'aura.rpc.memory.recall' "$DEP" || fail "deployment must subscribe aura.rpc.memory.recall"
grep -q 'aura-memory-recall' "$DEP" || fail "deployment must use queue-group aura-memory-recall"
grep -q 'memory.recall.done' "$DEP" || fail "deployment reply must mark memory.recall.done"
grep -Eq 'nats reply|-q' "$DEP" || fail "deployment must nats reply -q (queue-group)"

python3 - "$PKG" "$SKEL" <<'PY' || fail "package.yaml literal != skeleton.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches skeleton.js")
PY

# ROADMAP checkbox
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*recall RPC Function' "$ROADMAP" \
  || fail "ROADMAP M2 recall RPC Function checkbox must be [x]"

ok "services/memory recall RPC deploy (min≥2 · queue-group · no MQT)"
echo "check-memory-recall: PASS"
