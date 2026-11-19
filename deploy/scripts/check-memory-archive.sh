#!/usr/bin/env bash
# M4 static gate: aura.tasks.memory.archive — Parquet → DETACH/DROP.
# Exit 0 on PASS. Ticket 804e4fcc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-archive.md"
OBJ="$ROOT/deploy/docs/object-store-content-ref.md"
TTL="$ROOT/deploy/docs/memory-ttl-drop.md"
ARCH_DIR="$ROOT/services/memory/archive"
K8S_DIR="$ROOT/deploy/k8s/memory-archive"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
ARCH="$ROOT/ARCHITECTURE.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -d "$ARCH_DIR" ]] || fail "missing $ARCH_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q 'aura.tasks.memory.archive' "$DOC" || fail "doc must name aura.tasks.memory.archive"
grep -q 'aura.events.memory.archived' "$DOC" || fail "doc must name archived event"
grep -q 'aura.events.memory.archive.error' "$DOC" || fail "doc must name archive.error"
grep -Eqi 'Parquet|parquet' "$DOC" || fail "doc must require Parquet"
grep -Eqi 'DETACH' "$DOC" || fail "doc must require DETACH"
grep -Eq 'archive/episodic|archive/' "$DOC" || fail "doc must use archive/ prefix"
grep -q 'aura-content' "$DOC" || fail "doc must use aura-content bucket"
grep -Eqi 'PutObject|put_object|verify' "$DOC" || fail "doc must Put/verify before DROP"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'needs_archive' "$TTL" || fail "ttl-drop doc must keep needs_archive handoff"
grep -Eq 'archive/episodic|archive/' "$OBJ" || fail "object-store doc must define archive/ prefix"

PLAN="$ARCH_DIR/plan.js"
HANDLER="$ARCH_DIR/handler.js"
[[ -f "$PLAN" ]] || fail "missing $PLAN"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

grep -q 'aura-content' "$PLAN" || fail "plan must use aura-content"
grep -q 'archive/episodic' "$PLAN" || fail "plan must build archive/episodic keys"
grep -q '24' "$PLAN" || fail "plan must keep episodic 24mo hot window"
grep -q 'DETACH PARTITION' "$HANDLER" || fail "handler must DETACH PARTITION"
grep -q 'DROP TABLE' "$HANDLER" || fail "handler must DROP TABLE"
grep -Eq 'RESTRICT' "$HANDLER" || fail "handler must DROP … RESTRICT"
grep -q 'putObject\|put_object' "$HANDLER" || fail "handler must PutObject"
grep -q 'memory.archived' "$HANDLER" || fail "handler must emit memory.archived"
grep -q 'PAR1' "$HANDLER" || fail "handler stub must use PAR1 magic"
if grep -Eqi 'DROP[[:space:]]+TABLE[^;]*CASCADE' "$HANDLER"; then
  fail "archive must not automate DROP … CASCADE"
fi
# Put before DROP: crude source-order check
python3 - "$HANDLER" <<'PY' || fail "handler must PutObject before DETACH/DROP in source order"
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
i_put = text.find('putObject')
i_detach = text.find('DETACH PARTITION')
i_drop = text.find('DROP TABLE')
assert i_put >= 0 and i_detach > i_put and i_drop > i_detach, (i_put, i_detach, i_drop)
print('OK: put → detach → drop order')
PY

grep -Eqi 'archive|Parquet' "$DESIGN" || fail "DESIGN must cover archive"
grep -Eq 'aura\.tasks\.memory\.archive' "$ARCH" || fail "ARCHITECTURE must name archive task"
grep -Eq '\[x\].*aura\.tasks\.memory\.archive' "$ROADMAP" \
  || fail "ROADMAP M4 archive checkbox must be [x]"

node "$ARCH_DIR/plan.selftest.js" || fail "plan.selftest.js failed"
node "$ARCH_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
JS="$K8S_DIR/archive.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$JS" ]] || fail "missing $JS"

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt must be MessageQueueTrigger"
grep -q 'aura.tasks.memory.archive' "$MQT" || fail "mqt topic must be archive"
grep -q 'aura.events.memory.archived' "$MQT" || fail "mqt respTopic must be archived"
grep -q 'aura.events.memory.archive.error' "$MQT" || fail "mqt errorTopic must be archive.error"
grep -q 'aura_memory_archive' "$MQT" || fail "mqt consumer must be aura_memory_archive"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"
grep -q 'DETACH PARTITION' "$JS" || fail "archive.js must DETACH"
grep -q 'archive/episodic' "$JS" || fail "archive.js must use archive/episodic keys"

python3 - "$PKG" "$JS" <<'PY' || fail "package.yaml literal != archive.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches archive.js")
PY

ok "memory archive Parquet → DETACH/DROP + MQT"
echo "check-memory-archive: PASS"
