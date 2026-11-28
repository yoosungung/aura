#!/usr/bin/env bash
# M4 static gate: consolidate type-promotion (Rust) + Deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-consolidate-promotion.md"
DESIGN="$ROOT/services/memory/DESIGN.md"
PROMOTE_RS="$ROOT/services/memory/src/promote.rs"
K8S_DIR="$ROOT/deploy/k8s/memory-consolidate"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$PROMOTE_RS" ]] || fail "missing $PROMOTE_RS"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q 'aura.tasks.memory.consolidate' "$DOC" || fail "doc must name aura.tasks.memory.consolidate"
grep -Eqi 'similarity_only|유사도' "$DOC" || fail "doc must forbid similarity-only promotion"
grep -Eqi 'soft_close|valid_until' "$DOC" || fail "doc must describe soft_close / valid_until"
grep -Eqi 'insert_promoted|supersedes_id|INSERT' "$DOC" || fail "doc must describe insert_promoted / supersedes_id"
grep -Eq 'memory-consolidate-promotion\.md' "$ARCH" \
  || fail "ARCHITECTURE must link deploy/docs/memory-consolidate-promotion.md"
grep -q 'aura.tasks.memory.consolidate' "$DESIGN" || fail "DESIGN must name consolidate task"

grep -q 'similarity_only_forbidden' "$PROMOTE_RS" || fail "promote.rs must reject similarity_only"
grep -q 'short_term->episodic' "$PROMOTE_RS" || fail "promote.rs must allow short_term->episodic"
grep -q 'soft_close' "$PROMOTE_RS" || fail "promote.rs must soft_close"
grep -q 'insert_promoted' "$PROMOTE_RS" || fail "promote.rs must insert_promoted"

(cd "$ROOT" && cargo test -p aura-memory --lib promote --offline -- --nocapture) \
  || fail "aura-memory promote tests failed"

DEP="$K8S_DIR/deployment.yaml"
KUST="$K8S_DIR/kustomization.yaml"
[[ -f "$DEP" ]] || fail "missing $DEP"
grep -q 'kind: Deployment' "$DEP" || fail "deployment.yaml must be Deployment"
grep -q 'aura.tasks.memory.consolidate' "$DEP" || fail "deployment TASK_SUBJECT"
grep -q 'aura-memory-consolidate' "$DEP" || fail "deployment must run aura-memory-consolidate"
grep -q 'aura/memory-batch' "$DEP" || fail "deployment image aura/memory-batch"
if grep -qE 'function\.yaml|mqt\.yaml|package\.yaml' "$KUST"; then
  fail "kustomization must not list Fission resources"
fi

ok "consolidate promotion rules (Rust) + Deployment"
echo "check-memory-consolidate: PASS"
