#!/usr/bin/env bash
# M2+M4 gate: orphan content_ref GC docs + Rust object_gc worker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/object-store-orphan-gc.md"
IMPL="$ROOT/deploy/docs/memory-object-gc.md"
STORE="$ROOT/deploy/docs/object-store-content-ref.md"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
LIB="$ROOT/services/memory/src/lib.rs"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
K8S_DIR="$ROOT/deploy/k8s/memory-object-gc"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$IMPL" ]] || fail "missing $IMPL"
[[ -f "$HANDLERS" ]] || fail "missing handlers.rs"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -qE '90\s*일|90\s*days|interval '\''90 days'\''' "$DOC" \
  || fail "doc must fix orphan grace = 90 days"
grep -q 'aura.tasks.memory.object_gc' "$DOC" || fail "doc must name object_gc task"
grep -Eqi 'refs/' "$DOC" || fail "doc must scope GC to refs/"
grep -Eq 'object-store-orphan-gc\.md' "$ARCH" || fail "ARCHITECTURE must link orphan-gc doc"
grep -Eqi 'object_gc|고아' "$DESIGN" || fail "DESIGN must point at orphan GC"
grep -q 'should_skip_object_gc' "$LIB" || fail "lib must skip when ref linked"
grep -q 'object_gc_batch_key\|object-gc:' "$LIB" || fail "lib must build object-gc batch key"
grep -q 'handle_object_gc_request' "$HANDLERS" || fail "handlers must include object_gc"
grep -Eq '\[x\].*aura\.tasks\.memory\.object_gc' "$ROADMAP" || fail "ROADMAP M4 object_gc [x]"

(cd "$ROOT" && cargo test -p aura-memory --lib object_gc --offline) || fail "object_gc rust tests failed"

CJ="$K8S_DIR/cronjob.yaml"
[[ -f "$CJ" ]] || fail "missing cronjob.yaml"
[[ ! -f "$K8S_DIR/deployment.yaml" ]] || fail "batch Deployment must be removed (CronJob-only)"
grep -q '/aura-memory-object-gc' "$CJ" || fail "cronjob must run /aura-memory-object-gc"
grep -q 'aura/memory-batch' "$CJ" || fail "image aura/memory-batch"

ok "object-store-orphan-gc docs + CronJob one-shot"
echo "check-object-store-orphan-gc: PASS"
