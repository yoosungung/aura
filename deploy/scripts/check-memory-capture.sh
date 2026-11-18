#!/usr/bin/env bash
# M2 static gate: memory_capture DESIGN + MQT + PG-forbidden selftest.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory-capture/DESIGN.md"
CAPTURE_DIR="$ROOT/services/memory-capture"
K8S_DIR="$ROOT/deploy/k8s/memory-capture"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -d "$CAPTURE_DIR" ]] || fail "missing $CAPTURE_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN contracts
grep -q 'aura.tasks.memory.capture' "$DESIGN" || fail "DESIGN must name aura.tasks.memory.capture"
grep -q 'aura.events.memory.candidates' "$DESIGN" || fail "DESIGN must name aura.events.memory.candidates"
grep -q 'aura.events.memory.capture.error' "$DESIGN" || fail "DESIGN must name capture.error"
grep -Eqi 'PG|PostgreSQL' "$DESIGN" || fail "DESIGN must mention PG"
grep -Eqi '금지|forbid|forbidden|no PG|PG 금지' "$DESIGN" || fail "DESIGN must forbid PG"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"
grep -Eqi 'minReplicaCount.*0|scale-to-zero' "$DESIGN" || fail "DESIGN must state scale-to-zero / minReplicaCount=0"

HANDLER="$CAPTURE_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

# Source: no PG / pooler / set_config
if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST|aura-pg-pooler|\.query\s*\(" "$HANDLER" "$K8S_DIR/capture.js"; then
  fail "capture source must not use pg / set_config / AURA_DATABASE_HOST / .query("
fi

# Unit self-check
node "$CAPTURE_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests (§3.2)
MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
CAPTURE_JS="$K8S_DIR/capture.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$CAPTURE_JS" ]] || fail "missing $CAPTURE_JS"

python3 - "$PKG" "$CAPTURE_JS" <<'PY' || fail "package.yaml literal != capture.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches capture.js")
PY

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.memory.capture' "$MQT" || fail "mqt topic must be aura.tasks.memory.capture"
grep -q 'aura.events.memory.candidates' "$MQT" || fail "mqt respTopic must be aura.events.memory.candidates"
grep -q 'aura.events.memory.capture.error' "$MQT" || fail "mqt errorTopic must be aura.events.memory.capture.error"
grep -q 'aura_memory_capture' "$MQT" || fail "mqt consumer must be aura_memory_capture"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0 (scale-to-zero)"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

# ROADMAP checkbox
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*`memory_capture` Function \(PG 금지, MQT\) → `aura\.events\.memory\.candidates`' "$ROADMAP" \
  || fail "ROADMAP M2 memory_capture checkbox must be [x]"

ok "memory_capture DESIGN + MQT + PG-forbidden"
echo "check-memory-capture: PASS"
