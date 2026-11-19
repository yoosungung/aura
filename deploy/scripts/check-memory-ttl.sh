#!/usr/bin/env bash
# M1+M4 gate: TTL policy numbers + aura.tasks.memory.ttl DROP job.
# Exit 0 on PASS. Tickets: M1 policy · 2649c9a0 (M4 impl).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POLICY="$ROOT/deploy/docs/memory-ttl-policy.md"
DOC="$ROOT/deploy/docs/memory-ttl-drop.md"
TTL_DIR="$ROOT/services/memory/ttl"
K8S_DIR="$ROOT/deploy/k8s/memory-ttl"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
ARCH="$ROOT/ARCHITECTURE.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$POLICY" ]] || fail "missing $POLICY"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -d "$TTL_DIR" ]] || fail "missing $TTL_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# M1 policy numbers
grep -q "14일\|14 days\|interval '14 days'" "$POLICY" || fail "policy must fix short_term hot = 14 days"
grep -q "24개월\|24 months\|interval '24 months'" "$POLICY" || fail "policy must fix episodic hot = 24 months"
grep -q "12개월\|12 months\|interval '12 months'" "$POLICY" || fail "policy must fix audit hot = 12 months"
grep -q 'aura.tasks.memory.ttl' "$POLICY" || fail "policy must name aura.tasks.memory.ttl"
grep -qE '일 1회|daily' "$POLICY" || fail "policy must fix DROP cadence = daily"
grep -qi 'DROP' "$POLICY" || fail "policy must state partition DROP"

# M4 drop doc
grep -q 'aura.tasks.memory.ttl' "$DOC" || fail "drop doc must name task"
grep -q 'aura.events.memory.ttl.done' "$DOC" || fail "drop doc must name done event"
grep -q 'aura.events.memory.ttl.error' "$DOC" || fail "drop doc must name error event"
grep -Eqi 'needs_archive|archive' "$DOC" || fail "drop doc must coordinate episodic archive"
grep -Eqi 'Soft-delete|soft delete|valid_until' "$DOC" || fail "drop doc must forbid soft-delete-only"
grep -qi 'Non-goals' "$DOC" || fail "drop doc must state Non-goals"
grep -qE '일 1회|daily' "$DOC" || fail "drop doc must keep daily cadence"

PLAN="$TTL_DIR/partition-plan.js"
HANDLER="$TTL_DIR/handler.js"
[[ -f "$PLAN" ]] || fail "missing $PLAN"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

grep -q "14 days" "$PLAN" || fail "partition-plan must fix short_term 14 days"
grep -q "24 months" "$PLAN" || fail "partition-plan must fix episodic 24 months"
grep -q "12 months" "$PLAN" || fail "partition-plan must fix audit 12 months"
grep -q 'needs_archive' "$PLAN" || fail "partition-plan must emit needs_archive for cold episodic"
grep -q 'DROP TABLE' "$HANDLER" || fail "handler must DROP TABLE"
grep -Eq 'RESTRICT' "$HANDLER" || fail "handler must DROP … RESTRICT (no CASCADE automation)"
grep -Eq 'partition_name_unsafe|SAFE_NAME' "$HANDLER" || fail "handler must validate partition names"
grep -q 'aura-pg-pooler' "$HANDLER" || fail "handler must enforce pooler host"
grep -q 'memory.ttl.done' "$HANDLER" || fail "handler must emit memory.ttl.done"
if grep -Eqi 'DELETE[[:space:]]+FROM[[:space:]]+memory_items|DELETE[[:space:]]+FROM[[:space:]]+memory_audit' "$HANDLER" "$PLAN"; then
  fail "ttl must not DELETE FROM memory_* (partition DROP only)"
fi
if grep -Eqi 'DROP[[:space:]]+TABLE[^;]*CASCADE' "$HANDLER"; then
  fail "ttl must not automate DROP … CASCADE"
fi

grep -Eq 'memory-ttl-drop\.md|aura\.tasks\.memory\.ttl' "$DESIGN" || fail "DESIGN must cover ttl"
grep -Eq 'memory-ttl-policy\.md' "$ARCH" || fail "ARCHITECTURE must link memory-ttl-policy.md"
grep -Eq '\[x\].*aura\.tasks\.memory\.ttl' "$ROADMAP" \
  || fail "ROADMAP M4 ttl checkbox must be [x]"

node "$TTL_DIR/partition-plan.selftest.js" || fail "partition-plan.selftest.js failed"
node "$TTL_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
TTL_JS="$K8S_DIR/ttl.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$TTL_JS" ]] || fail "missing $TTL_JS"

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.memory.ttl' "$MQT" || fail "mqt topic must be aura.tasks.memory.ttl"
grep -q 'aura.events.memory.ttl.done' "$MQT" || fail "mqt respTopic must be ttl.done"
grep -q 'aura.events.memory.ttl.error' "$MQT" || fail "mqt errorTopic must be ttl.error"
grep -q 'aura_memory_ttl' "$MQT" || fail "mqt consumer must be aura_memory_ttl"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"
grep -Eq "set_config\('app\.tenant_id'" "$TTL_JS" && fail "ttl.js must not require tenant GUC for DDL DROP" || true
grep -q 'DROP TABLE' "$TTL_JS" || fail "ttl.js must DROP TABLE"
grep -q 'needs_archive' "$TTL_JS" || fail "ttl.js must handle needs_archive"

python3 - "$PKG" "$TTL_JS" <<'PY' || fail "package.yaml literal != ttl.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches ttl.js")
PY

ok "memory ttl policy + DROP job + MQT"
echo "check-memory-ttl: PASS"
