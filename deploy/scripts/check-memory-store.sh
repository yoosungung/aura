#!/usr/bin/env bash
# M1 static gate: services/memory DESIGN + store MQT + set_config(..., true).
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory/DESIGN.md"
STORE_DIR="$ROOT/services/memory/store"
K8S_DIR="$ROOT/deploy/k8s/memory-store"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -d "$STORE_DIR" ]] || fail "missing $STORE_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN contracts
grep -q 'set_config' "$DESIGN" || fail "DESIGN must document set_config"
grep -Eq "set_config\('app\.tenant_id',\s*\$1,\s*true\)|set_config\('app\.tenant_id',\s*.*,\s*true\)" "$DESIGN" \
  || fail "DESIGN must require set_config('app.tenant_id', …, true)"
grep -Eqi 'is_local|트랜잭션 로컬|true\)' "$DESIGN" || fail "DESIGN must state is_local=true / transaction-local"
grep -Eqi 'set_config\(.*,\s*false\)|세션.*SET|금지' "$DESIGN" || fail "DESIGN must forbid set_config(..., false) / session SET"
grep -q 'aura.tasks.memory.store' "$DESIGN" || fail "DESIGN must name aura.tasks.memory.store"
grep -q 'aura.events.memory.stored' "$DESIGN" || fail "DESIGN must name aura.events.memory.stored"
grep -q 'aura-pg-pooler' "$DESIGN" || fail "DESIGN must require pooler DSN (aura-pg-pooler)"
grep -Eqi 'Non-goals|본구현' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"

# Source: tenant tx helper + handler must use is_local=true; never false
TENANT_TX="$STORE_DIR/tenant-tx.js"
HANDLER="$STORE_DIR/handler.js"
[[ -f "$TENANT_TX" ]] || fail "missing $TENANT_TX"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

grep -q "set_config('app.tenant_id'" "$TENANT_TX" || fail "tenant-tx.js must call set_config('app.tenant_id', …)"
grep -Eq "set_config\('app\.tenant_id',\s*\$1,\s*true\)|,\s*true\)" "$TENANT_TX" \
  || fail "tenant-tx.js must pass is_local=true"
if grep -Eq "set_config\([^)]*,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$TENANT_TX" "$HANDLER"; then
  fail "store source must not use set_config(..., false) or SET app.tenant_id"
fi
grep -q 'withTenantTx\|with_tenant_tx' "$HANDLER" || fail "handler.js must use withTenantTx"
grep -Eqi 'aura-pg-pooler|AURA_DATABASE_HOST|pooler' "$HANDLER" "$TENANT_TX" "$DESIGN" \
  || fail "store path must reference pooler / AURA_DATABASE_HOST"

# Unit self-checks (fake client records set_config true before work)
node "$STORE_DIR/tenant-tx.selftest.js" || fail "tenant-tx.selftest.js failed"
node "$STORE_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests (§3.2)
MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
STORE_JS="$K8S_DIR/store.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$STORE_JS" ]] || fail "missing $STORE_JS"

grep -Eq 'set_config\('\''app\.tenant_id'\'',\s*\$1,\s*true\)' "$STORE_JS" \
  || fail "store.js Package entry must call set_config(..., true)"
# package.yaml literal must match store.js bytes
python3 - "$PKG" "$STORE_JS" <<'PY' || fail "package.yaml literal != store.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches store.js")
PY

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.memory.store' "$MQT" || fail "mqt topic must be aura.tasks.memory.store"
grep -q 'aura.events.memory.stored' "$MQT" || fail "mqt respTopic must be aura.events.memory.stored"
grep -q 'aura.events.memory.store.error' "$MQT" || fail "mqt errorTopic must be aura.events.memory.store.error"
grep -q 'aura_memory_store' "$MQT" || fail "mqt consumer must be aura_memory_store"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0 (scale-to-zero)"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

# ROADMAP checkbox
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*services/memory/DESIGN\.md.*store MQT|\[x\].*store MQT.*set_config' "$ROADMAP" \
  || fail "ROADMAP M1 store MQT checkbox must be [x]"

ok "services/memory DESIGN + store MQT + set_config(..., true)"
echo "check-memory-store: PASS"
