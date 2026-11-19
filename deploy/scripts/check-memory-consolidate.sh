#!/usr/bin/env bash
# M4 static gate: consolidate type-promotion rules + MQT + selftests.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-consolidate-promotion.md"
DESIGN="$ROOT/services/memory/DESIGN.md"
CONS_DIR="$ROOT/services/memory/consolidate"
K8S_DIR="$ROOT/deploy/k8s/memory-consolidate"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -d "$CONS_DIR" ]] || fail "missing $CONS_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"

# Policy doc invariants
grep -q 'aura.tasks.memory.consolidate' "$DOC" || fail "doc must name aura.tasks.memory.consolidate"
grep -Eqi 'similarity_only|유사도' "$DOC" || fail "doc must forbid similarity-only promotion"
grep -q 'short_term' "$DOC" && grep -q 'episodic' "$DOC" || fail "doc must name short_term→episodic path"
grep -q 'long_term' "$DOC" && grep -q 'semantic' "$DOC" || fail "doc must name episodic→long_term/semantic"
grep -Eqi 'soft_close|valid_until' "$DOC" || fail "doc must describe soft_close / valid_until"
grep -Eqi 'insert_promoted|supersedes_id|INSERT' "$DOC" || fail "doc must describe insert_promoted / supersedes_id"
grep -Eqi 'UPDATE memory_type|in-place' "$DOC" || fail "doc must forbid in-place UPDATE memory_type"
grep -Eq 'evidence_count|≥ 3|>= 3' "$DOC" || fail "doc must fix recurrence evidence_count ≥ 3"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"

# ARCHITECTURE + DESIGN cross-links
grep -Eq 'memory-consolidate-promotion\.md' "$ARCH" \
  || fail "ARCHITECTURE must link deploy/docs/memory-consolidate-promotion.md"
grep -Eqi 'consolidate|승격' "$DESIGN" || fail "DESIGN must cover consolidate"
grep -q 'aura.tasks.memory.consolidate' "$DESIGN" || fail "DESIGN must name consolidate task"
grep -Eqi 'similarity_only|유사도' "$DESIGN" || fail "DESIGN must forbid similarity-only"

PROMOTE="$CONS_DIR/promote.js"
HANDLER="$CONS_DIR/handler.js"
[[ -f "$PROMOTE" ]] || fail "missing $PROMOTE"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

grep -q 'similarity_only_forbidden' "$PROMOTE" || fail "promote.js must reject similarity_only"
grep -q 'short_term->episodic' "$PROMOTE" || fail "promote.js must allow short_term->episodic"
grep -q 'withTenantTx\|with_tenant_tx' "$HANDLER" || fail "handler.js must use withTenantTx"
grep -Eq "set_config\('app\.tenant_id'" "$ROOT/services/memory/store/tenant-tx.js" \
  || fail "tenant-tx.js must call set_config"
if grep -Eq "set_config\([^)]*,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$HANDLER" "$PROMOTE"; then
  fail "consolidate source must not use set_config(..., false) or SET app.tenant_id"
fi
# Forbid SQL-shaped in-place type mutation (comments saying "never UPDATE memory_type" are OK).
if grep -Eqi "UPDATE[[:space:]]+memory_items|[[:space:]]SET[[:space:]]+memory_type[[:space:]]*=" "$HANDLER" "$PROMOTE"; then
  fail "consolidate must not UPDATE memory_type in place"
fi

# store/embed must not promote types
for f in "$ROOT/services/memory/store/handler.js" "$ROOT/services/memory/embed/handler.js"; do
  [[ -f "$f" ]] || continue
  if grep -Eqi 'planPromotion|insert_promoted|similarity_only' "$f"; then
    fail "$(basename "$f") must not implement type promotion"
  fi
done

node "$CONS_DIR/promote.selftest.js" || fail "promote.selftest.js failed"
node "$CONS_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests
MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
CONS_JS="$K8S_DIR/consolidate.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$CONS_JS" ]] || fail "missing $CONS_JS"

grep -Eq "set_config\('app\.tenant_id',\s*\\\$1,\s*true\)" "$CONS_JS" \
  || fail "consolidate.js Package entry must call set_config(..., true)"
grep -q 'similarity_only_forbidden' "$CONS_JS" || fail "consolidate.js must reject similarity_only"

python3 - "$PKG" "$CONS_JS" <<'PY' || fail "package.yaml literal != consolidate.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches consolidate.js")
PY

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.memory.consolidate' "$MQT" || fail "mqt topic must be aura.tasks.memory.consolidate"
grep -q 'aura.events.memory.consolidated' "$MQT" || fail "mqt respTopic must be aura.events.memory.consolidated"
grep -q 'aura.events.memory.consolidate.error' "$MQT" || fail "mqt errorTopic must be consolidate.error"
grep -q 'aura_memory_consolidate' "$MQT" || fail "mqt consumer must be aura_memory_consolidate"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

grep -Eq '\[x\].*aura\.tasks\.memory\.consolidate.*유형 승격' "$ROADMAP" \
  || fail "ROADMAP M4 consolidate checkbox must be [x]"

ok "consolidate promotion rules + MQT + similarity_only forbidden"
echo "check-memory-consolidate: PASS"
