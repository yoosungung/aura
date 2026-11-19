#!/usr/bin/env bash
# M2+M4 static gate: recall hybrid RRF — short_term recent + BM25/vector RRF + graph walk,
# iterative_scan/ef_search GUCs, Pooler + set_config(..., true), Warm Pool deploy, no MQT.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory/DESIGN.md"
RECALL_DIR="$ROOT/services/memory/recall"
K8S_DIR="$ROOT/deploy/k8s/memory-recall"
ROADMAP="$ROOT/ROADMAP.md"
TENANT_TX="$ROOT/services/memory/store/tenant-tx.js"

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
grep -Eqi 'hybrid RRF|hybrid_rrf|RRF' "$DESIGN" || fail "DESIGN must document hybrid RRF"
grep -Eqi 'short_term' "$DESIGN" || fail "DESIGN must document short_term recent path"
grep -Eqi 'iterative_scan' "$DESIGN" || fail "DESIGN must require iterative_scan"
grep -Eqi 'ef_search' "$DESIGN" || fail "DESIGN must require ef_search"
grep -Eqi 'graph-walk|graph walk|mode: .walk.|방어적' "$DESIGN" || fail "DESIGN must mention graph walk"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"

HANDLER="$RECALL_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
grep -q 'aura.rpc.memory.recall' "$HANDLER" || fail "handler must name aura.rpc.memory.recall"
grep -q 'memory.recall.done' "$HANDLER" || fail "handler must emit memory.recall.done"
grep -Eqi 'hybrid_rrf|fuseRrf' "$HANDLER" || fail "handler must implement hybrid RRF (fuseRrf / hybrid_rrf)"
grep -Eq 'withTenantTx|with_tenant_tx' "$HANDLER" || fail "handler must use withTenantTx"
# vector SQL must keep tenant_id in the same statement (no app post-filter)
python3 - "$HANDLER" <<'PY' || fail "vector SELECT must include tenant_id in same SQL"
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r"async function selectVector[\s\S]*?const sql = `([\s\S]*?)`", text)
assert m, "selectVector sql not found"
sql = m.group(1)
assert re.search(r"tenant_id\s*=", sql, re.I), "tenant_id missing in vector SQL"
assert "<=>" in sql or "halfvec" in sql
print("OK: vector SQL has tenant WHERE")
PY
grep -Eq "SET LOCAL hnsw\.iterative_scan" "$HANDLER" || fail "handler must SET LOCAL hnsw.iterative_scan"
grep -Eq "SET LOCAL hnsw\.ef_search" "$HANDLER" || fail "handler must SET LOCAL hnsw.ef_search"
grep -Eq "SET LOCAL hnsw\.max_scan_tuples" "$HANDLER" || fail "handler must SET LOCAL hnsw.max_scan_tuples"
grep -Eqi 'short_term|created_at DESC' "$HANDLER" || fail "handler must query short_term recent"
grep -Eqi 'ts_rank|content_tsv' "$HANDLER" || fail "handler must query BM25 (content_tsv/ts_rank)"
grep -Eqi 'halfvec|<=>' "$HANDLER" || fail "handler must query vector halfvec distance"
grep -Eq 'walkGraph|graph-walk|runGraphWalk' "$HANDLER" || fail "handler must call graph walk"
grep -Eq "branches: \['bm25', 'vector', 'graph'\]" "$HANDLER" || fail "rrf branches must include graph (not graph_stub)"
grep -Eq "set_config\('app\.tenant_id'" "$TENANT_TX" || fail "tenant-tx.js must call set_config"
if grep -Eq "set_config\([^)]*,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$HANDLER"; then
  fail "recall source must not use set_config(..., false) or SET app.tenant_id"
fi
# top-level success body must be hybrid_rrf
grep -q "mode: 'hybrid_rrf'" "$HANDLER" || fail "handler success path must set mode: 'hybrid_rrf'"
if grep -Eq "mode:\s*'stub'" "$HANDLER"; then
  fail "handler must not keep graph mode stub after M4 walk"
fi

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
grep -Eq '\[x\].*recall:.*short_term|\[x\].*hybrid RRF' "$ROADMAP" \
  || fail "ROADMAP M2 hybrid RRF recall checkbox must be [x]"

ok "services/memory recall hybrid RRF (short_term recent · BM25/vector · graph walk · GUCs)"
echo "check-memory-recall: PASS"
