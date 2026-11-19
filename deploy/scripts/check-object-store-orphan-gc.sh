#!/usr/bin/env bash
# M2+M4 gate: orphan content_ref GC algorithm + object_gc job.
# Exit 0 on PASS. Tickets: bb165a71 (M2) · 67cbadb8 (M4).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/object-store-orphan-gc.md"
IMPL="$ROOT/deploy/docs/memory-object-gc.md"
STORE="$ROOT/deploy/docs/object-store-content-ref.md"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
GC_DIR="$ROOT/services/memory/object-gc"
K8S_DIR="$ROOT/deploy/k8s/memory-object-gc"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$IMPL" ]] || fail "missing $IMPL"
[[ -f "$STORE" ]] || fail "missing $STORE"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
[[ -d "$GC_DIR" ]] || fail "missing $GC_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# Grace / TTL locked to 90 days (align AURA_EVENTS).
grep -qE '90\s*일|90\s*days|interval '\''90 days'\''' "$DOC" \
  || fail "doc must fix orphan grace = 90 days"
grep -Eqi 'AURA_EVENTS|90' "$DOC" \
  || fail "doc must align grace with AURA_EVENTS retention"

# Task + cadence + idempotency.
grep -q 'aura.tasks.memory.object_gc' "$DOC" \
  || fail "doc must name aura.tasks.memory.object_gc"
grep -qE '일 1회|daily' "$DOC" || fail "doc must fix GC cadence = daily (일 1회)"
grep -Eqi '멱등|idempot' "$DOC" || fail "doc must lock idempotent task/object keys"

# Algorithm: candidate → ref check → delete/skip; batch.
grep -Eqi 'ListObjects|ListObject|후보|candidate' "$DOC" \
  || fail "doc must describe candidate listing under refs/"
grep -Eqi '참조|EXISTS|skip|스킵' "$DOC" \
  || fail "doc must require skip when live references exist"
grep -Eqi 'DeleteObject|삭제' "$DOC" || fail "doc must describe DeleteObject for orphans"
grep -Eqi '배치|batch' "$DOC" || fail "doc must lock batch size / batch delete"

# Scope / safety.
grep -Eqi 'refs/' "$DOC" || fail "doc must scope GC to tenants/.../refs/"
grep -Eqi 'archive|bundles' "$DOC" \
  || fail "doc must exclude archive/ and bundles/ prefixes"
grep -Eqi 'aura-content|Garage' "$DOC" \
  || fail "doc must stay on Garage / aura-content contract"
grep -qi 'Non-goals' "$DOC" || fail "doc must state Non-goals"

# Cross-links.
grep -Eq 'object-store-orphan-gc\.md' "$ARCH" \
  || fail "ARCHITECTURE must link deploy/docs/object-store-orphan-gc.md"
grep -Eq 'object_gc|object-store-orphan-gc' "$ARCH" \
  || fail "ARCHITECTURE §3.2 must name object_gc task or orphan-gc doc"
grep -Eqi 'object-store-orphan-gc|object_gc|고아' "$DESIGN" \
  || fail "services/memory/DESIGN.md must point at orphan GC"
grep -Eqi 'object-store-orphan-gc|object_gc|고아 GC' "$ROADMAP" \
  || fail "ROADMAP must cite orphan GC doc / V2.2"
grep -Eqi '고아 GC|object_gc|orphan' "$STORE" \
  || fail "object-store-content-ref.md must point GC to V2.2 doc"

# M4 implementation
grep -q 'aura.tasks.memory.object_gc' "$IMPL" || fail "impl doc must name task"
grep -q 'aura.events.memory.object_gc.done' "$IMPL" || fail "impl doc must name done event"
grep -q '90' "$IMPL" || fail "impl doc must keep 90d grace"
PLAN="$GC_DIR/plan.js"
HANDLER="$GC_DIR/handler.js"
[[ -f "$PLAN" ]] || fail "missing $PLAN"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
grep -q 'GRACE_DAYS = 90\|90' "$PLAN" || fail "plan must fix GRACE_DAYS=90"
grep -q 'BATCH_LIMIT = 100\|100' "$PLAN" || fail "plan must fix batch 100"
grep -q 'refs/' "$PLAN" || fail "plan must scope refs/"
grep -q 'DeleteObject\|deleteObject' "$HANDLER" || fail "handler must DeleteObject"
grep -q 'set_config\|withTenantTx' "$HANDLER" || fail "handler must use tenant GUC"
grep -q "content_ref,bucket\|content_ref" "$HANDLER" || fail "handler must check content_ref metadata"
grep -q 'memory.object_gc.done' "$HANDLER" || fail "handler must emit object_gc.done"
grep -q 'object-gc:' "$PLAN" || fail "plan must build idempotent object-gc: id"
grep -Eq '\[x\].*aura\.tasks\.memory\.object_gc' "$ROADMAP" \
  || fail "ROADMAP M4 object_gc checkbox must be [x]"

node "$GC_DIR/plan.selftest.js" || fail "plan.selftest.js failed"
node "$GC_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

MQT="$K8S_DIR/mqt.yaml"
PKG="$K8S_DIR/package.yaml"
JS="$K8S_DIR/object-gc.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$JS" ]] || fail "missing $JS"
grep -q 'aura.tasks.memory.object_gc' "$MQT" || fail "mqt topic must be object_gc"
grep -q 'aura.events.memory.object_gc.done' "$MQT" || fail "mqt respTopic must be object_gc.done"
grep -q 'aura.events.memory.object_gc.error' "$MQT" || fail "mqt errorTopic must be object_gc.error"
grep -q 'aura_memory_object_gc' "$MQT" || fail "mqt consumer must be aura_memory_object_gc"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0"
grep -q "set_config('app.tenant_id'" "$JS" || fail "object-gc.js must set_config(..., true)"

python3 - "$PKG" "$JS" <<'PY' || fail "package.yaml literal != object-gc.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches object-gc.js")
PY

ok "object-store-orphan-gc 90d + object_gc MQT + skip-if-ref + batch"
echo "check-object-store-orphan-gc: PASS"
