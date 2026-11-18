#!/usr/bin/env bash
# M2 static gate: orphan content_ref GC algorithm (doc-only; impl=M4).
# Exit 0 on PASS. Ticket bb165a71.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/object-store-orphan-gc.md"
STORE="$ROOT/deploy/docs/object-store-content-ref.md"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$STORE" ]] || fail "missing $STORE"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"

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
grep -qi 'Non-goals\|본구현' "$DOC" \
  || fail "doc must state Non-goals (no job impl in M2)"

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
  || fail "object-store-content-ref.md must point GC to V2.2 doc (not open child)"

ok "object-store-orphan-gc.md 90d + object_gc + skip-if-ref + batch + ARCHITECTURE link"
echo "check-object-store-orphan-gc: PASS"
