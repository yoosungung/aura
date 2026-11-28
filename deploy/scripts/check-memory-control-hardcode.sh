#!/usr/bin/env bash
# Static gate: memory/control-resolve/compliance Fission→Deployment hardcode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

DOC="$ROOT/deploy/docs/memory-control-hardcode.md"
[[ -f "$DOC" ]] || fail "missing $DOC"
grep -qE '별도.*memory 파드 비포함|memory 파드 비포함' "$DOC" || fail "doc must state compliance separate Deployment"
grep -q 'aura-memory-recall' "$DOC" || fail "doc must name memory-recall"

for d in memory-capture memory-recall memory-consolidate \
  memory-ttl memory-archive memory-object-gc control-resolve compliance-erase; do
  [[ -f "$ROOT/deploy/k8s/$d/deployment.yaml" ]] || fail "missing deployment.yaml in $d"
  [[ -f "$ROOT/deploy/k8s/$d/kustomization.yaml" ]] || fail "missing kustomization in $d"
  if grep -q 'kind: Function' "$ROOT/deploy/k8s/$d/kustomization.yaml" 2>/dev/null; then
    fail "$d kustomization still references Function"
  fi
  if grep -q 'function.yaml\|mqt.yaml\|package.yaml' "$ROOT/deploy/k8s/$d/kustomization.yaml"; then
    fail "$d kustomization still lists Fission resources"
  fi
done

grep -q 'deployment.yaml' "$ROOT/deploy/k8s/compliance-erase/kustomization.yaml" \
  || fail "compliance-erase must apply Deployment"
grep -q 'aura-compliance-erase' "$ROOT/deploy/k8s/compliance-erase/deployment.yaml" \
  || fail "compliance-erase deployment name"

# rpc-bridge maps recall/resolve subjects (Service HTTP cutover = follow-up)
grep -q 'aura.rpc.control.resolve' "$ROOT/services/nats-rpc-bridge/src/lib.rs" \
  || fail "rust bridge missing control.resolve map"
grep -q 'aura-control-resolve' "$ROOT/services/nats-rpc-bridge/src/lib.rs" \
  || fail "rust bridge missing aura-control-resolve target"

# agent/mcp rs removed
[[ ! -d "$ROOT/services/agent-invoke/rs" ]] || fail "agent-invoke/rs should be deleted"
[[ ! -d "$ROOT/services/mcp-invoke/rs" ]] || fail "mcp-invoke/rs should be deleted"
grep -q 'services/agent-invoke/rs' "$ROOT/Cargo.toml" && fail "Cargo.toml still lists agent-invoke/rs" || true
grep -q 'services/mcp-invoke/rs' "$ROOT/Cargo.toml" && fail "Cargo.toml still lists mcp-invoke/rs" || true

# apply-product no longer packages memory-recall/control-resolve zips
grep -q 'build-hardcoded-memory-images' "$ROOT/deploy/scripts/apply-product.sh" \
  || fail "apply-product must build hardcoded images"
grep 'apply_pkg_zip_literal aura-memory-recall\|apply_pkg_zip_literal aura-control-resolve' \
  "$ROOT/deploy/scripts/apply-product.sh" && fail "apply-product still packages recall/resolve" || true

echo "check-memory-control-hardcode: PASS"
