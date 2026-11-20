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
grep -Eqi 'poolmgr|poolsize|nats-rpc-bridge|replicas ≥ 2|replicas >= 2' "$DESIGN" \
  || fail "DESIGN must require poolmgr/bridge Warm (≥2)"
grep -Eqi 'aura-rpc-bridge|nats-rpc-bridge|queue-group|queue group' "$DESIGN" \
  || fail "DESIGN must name shared bridge queue"
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

# Manifests — sync poolmgr + shared bridge, no JetStream MQT / *-rr
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
KUST="$K8S_DIR/kustomization.yaml"
ARCH_ZIP="$K8S_DIR/archive.zip"
BRIDGE_DEP="$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$KUST" ]] || fail "missing $KUST"
[[ -f "$ARCH_ZIP" ]] || fail "missing $ARCH_ZIP (run build-memory-recall-archive.sh)"
[[ -f "$BRIDGE_DEP" ]] || fail "missing $BRIDGE_DEP"
[[ ! -f "$K8S_DIR/rpc-responder.yaml" ]] || fail "rpc-responder.yaml must be removed (shared bridge)"

if grep -REq 'kind:[[:space:]]*MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$K8S_DIR"/*.yaml; then
  fail "memory-recall must not include MessageQueueTrigger or ScaledObject"
fi
if grep -E '^[[:space:]]*-[[:space:]]*rpc-responder\.yaml' "$KUST"; then
  fail "kustomization must not list rpc-responder.yaml"
fi
if grep -E '^[[:space:]]*-[[:space:]]*mqt\.yaml' "$KUST"; then
  fail "kustomization must not list mqt.yaml"
fi

grep -q 'aura.runtime/class: sync' "$FN" || fail "function must label aura.runtime/class=sync"
grep -q 'name: aura-nodejs-sync' "$FN" || fail "function must use aura-nodejs-sync"
grep -Eq 'ExecutorType:[[:space:]]*poolmgr' "$FN" || fail "function ExecutorType must be poolmgr"
ENV_SYNC="$ROOT/deploy/k8s/runtime-envs/aura-nodejs-sync.yaml"
[[ -f "$ENV_SYNC" ]] || fail "missing $ENV_SYNC"
grep -Eq 'poolsize:[[:space:]]*[2-9]|poolsize:[[:space:]]*[1-9][0-9]' "$ENV_SYNC" \
  || fail "aura-nodejs-sync poolsize must be >= 2"

grep -q 'name: aura-nats-rpc-bridge' "$BRIDGE_DEP" || fail "bridge deployment must be aura-nats-rpc-bridge"
grep -Eq 'namespace:[[:space:]]*aura' "$BRIDGE_DEP" || fail "bridge deployment must be ns aura"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$BRIDGE_DEP" \
  || fail "bridge replicas must be >= 2"
grep -q 'aura-rpc-bridge' "$BRIDGE_DEP" || fail "bridge must use queue aura-rpc-bridge"
grep -q 'FISSION_ROUTER_URL' "$BRIDGE_DEP" || fail "bridge must set FISSION_ROUTER_URL"
python3 - "$ARCH_ZIP" <<'PY' || fail "archive must include recall/handler.js + index.js"
import zipfile, sys
names = zipfile.ZipFile(sys.argv[1]).namelist()
assert any(n.endswith("recall/handler.js") for n in names), names
assert any(n.endswith("index.js") for n in names), names
print("OK: memory-recall archive entries")
PY

# ROADMAP checkbox
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*recall RPC Function' "$ROADMAP" \
  || fail "ROADMAP M2 recall RPC Function checkbox must be [x]"
grep -Eq '\[x\].*recall:.*short_term|\[x\].*hybrid RRF' "$ROADMAP" \
  || fail "ROADMAP M2 hybrid RRF recall checkbox must be [x]"

ok "services/memory recall hybrid RRF (short_term recent · BM25/vector · graph walk · GUCs)"
echo "check-memory-recall: PASS"
