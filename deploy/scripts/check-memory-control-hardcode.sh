#!/usr/bin/env bash
# Static gate: memory/control/compliance hardcode — Deployments for capture/recall/resolve/erase;
# batch = CronJob only (no always-on pods).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

DOC="$ROOT/deploy/docs/memory-control-hardcode.md"
[[ -f "$DOC" ]] || fail "missing $DOC"
grep -qE '별도.*memory 파드 비포함|memory 파드 비포함' "$DOC" || fail "doc must state compliance separate Deployment"
grep -q 'aura-memory-recall' "$DOC" || fail "doc must name memory-recall"

for d in memory-capture memory-recall control-resolve compliance-erase; do
  [[ -f "$ROOT/deploy/k8s/$d/deployment.yaml" ]] || fail "missing deployment.yaml in $d"
  [[ -f "$ROOT/deploy/k8s/$d/kustomization.yaml" ]] || fail "missing kustomization in $d"
  if grep -q 'function.yaml\|mqt\.yaml\|package.yaml' "$ROOT/deploy/k8s/$d/kustomization.yaml"; then
    fail "$d kustomization still lists Fission resources"
  fi
done

for d in memory-consolidate memory-ttl memory-archive memory-object-gc; do
  [[ -f "$ROOT/deploy/k8s/$d/cronjob.yaml" ]] || fail "missing cronjob.yaml in $d"
  [[ ! -f "$ROOT/deploy/k8s/$d/deployment.yaml" ]] || fail "$d must not keep always-on Deployment"
  [[ -f "$ROOT/deploy/k8s/$d/kustomization.yaml" ]] || fail "missing kustomization in $d"
done

grep -q 'deployment.yaml' "$ROOT/deploy/k8s/compliance-erase/kustomization.yaml" \
  || fail "compliance-erase must apply Deployment"
grep -q 'aura-compliance-erase' "$ROOT/deploy/k8s/compliance-erase/deployment.yaml" \
  || fail "compliance-erase deployment name"

grep -q 'aura.rpc.control.resolve' "$ROOT/services/nats-rpc-bridge/src/lib.rs" \
  || fail "rust bridge missing control.resolve map"
grep -q 'aura-control-resolve' "$ROOT/services/nats-rpc-bridge/src/lib.rs" \
  || fail "rust bridge missing aura-control-resolve target"

[[ ! -d "$ROOT/services/agent-invoke/rs" ]] || fail "agent-invoke/rs should be deleted"
[[ ! -d "$ROOT/services/mcp-invoke/rs" ]] || fail "mcp-invoke/rs should be deleted"

grep -q 'build-hardcoded-memory-images' "$ROOT/deploy/scripts/apply-product.sh" \
  || fail "apply-product must build hardcoded images"

echo "check-memory-control-hardcode: PASS"
