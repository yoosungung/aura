#!/usr/bin/env bash
# M5 static gate: high-risk tenant dedicated RuntimeClass / node-pool policy (§9.1).
# Doc + RuntimeClass scheduling + offline placement selftest. Live pool provision = Non-goal.
# Exit 0 on PASS. Ticket c645e340.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/high-risk-tenant-nodepool.md"
RC_KATA="$ROOT/deploy/k8s/sandbox-egress/runtimeclass-kata.yaml"
RC_GVISOR="$ROOT/deploy/k8s/sandbox-egress/runtimeclass-gvisor.yaml"
DRAFT="$ROOT/deploy/k8s/sandbox-egress/nodepool-high-risk.draft.yaml"
KUST="$ROOT/deploy/k8s/sandbox-egress/kustomization.yaml"
PLACE="$ROOT/services/sandbox-egress/high-risk-placement.js"
PLACE_TEST="$ROOT/services/sandbox-egress/high-risk-placement.selftest.js"
ISOLATION="$ROOT/deploy/docs/mcp-bundle-isolation.md"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"
DESIGN="$ROOT/services/mcp-invoke/DESIGN.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$RC_KATA" ]] || fail "missing $RC_KATA"
[[ -f "$RC_GVISOR" ]] || fail "missing $RC_GVISOR"
[[ -f "$DRAFT" ]] || fail "missing $DRAFT"
[[ -f "$PLACE" ]] || fail "missing $PLACE"
[[ -f "$PLACE_TEST" ]] || fail "missing $PLACE_TEST"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'RuntimeClass' "$DOC" || fail "doc must name RuntimeClass"
grep -Eqi 'Kata|kata' "$DOC" || fail "doc must pin Kata for high-risk"
grep -Eqi 'nodeSelector|노드풀|node.?pool|taint' "$DOC" || fail "doc must define node pool / taint / nodeSelector"
grep -Eq 'aura\.sandbox/pool' "$DOC" || fail "doc must pin label aura.sandbox/pool"
grep -Eqi 'risk_tier|risk-tier|고위험' "$DOC" || fail "doc must define high-risk classification"
grep -Eqi 'gvisor|gVisor' "$DOC" || fail "doc must keep gVisor as default tier"
grep -q 'mcp-bundle-isolation' "$DOC" || fail "doc must link mcp-bundle-isolation"
grep -q 'high-risk-tenant-nodepool' "$ISOLATION" \
  || fail "mcp-bundle-isolation must link high-risk-tenant-nodepool"

# Kata RuntimeClass must constrain scheduling to dedicated pool
grep -q 'handler: kata-qemu' "$RC_KATA" || fail "kata RuntimeClass handler must be kata-qemu"
grep -q 'scheduling:' "$RC_KATA" || fail "kata RuntimeClass must declare scheduling"
grep -q 'aura.sandbox/pool: kata' "$RC_KATA" || fail "kata RuntimeClass nodeSelector must require aura.sandbox/pool=kata"
grep -Eq 'tolerations:' "$RC_KATA" || fail "kata RuntimeClass must declare tolerations"
grep -q 'aura.sandbox/pool' "$RC_KATA" || fail "kata toleration must match pool taint key"
grep -q 'NoSchedule' "$RC_KATA" || fail "kata toleration effect must be NoSchedule"

# gVisor must NOT steal kata pool (no kata pool selector)
if grep -q 'aura.sandbox/pool: kata' "$RC_GVISOR"; then
  fail "gvisor RuntimeClass must not select kata pool"
fi
grep -q 'handler: runsc' "$RC_GVISOR" || fail "gvisor must keep runsc"

# Draft documents node labels + taints for operators
grep -q 'aura.sandbox/pool: kata' "$DRAFT" || fail "draft must document node label aura.sandbox/pool=kata"
grep -q 'NoSchedule' "$DRAFT" || fail "draft must document NoSchedule taint"
grep -q 'runtimeclass-kata.yaml' "$KUST" || fail "kustomization must include kata RuntimeClass"

# Cross-links + ROADMAP
grep -q 'high-risk-tenant-nodepool.md' "$ARCH" \
  || fail "ARCHITECTURE §9.1 must link high-risk-tenant-nodepool.md"
grep -Eq '\[x\].*고위험.*RuntimeClass|\[x\].*고위험.*노드풀|\[x\].*high-risk-tenant-nodepool' "$ROADMAP" \
  || fail "ROADMAP high-risk RuntimeClass/nodepool checkbox must be [x]"
grep -q 'check-high-risk-tenant-nodepool' "$SETUP" \
  || fail "SETUP must name check-high-risk-tenant-nodepool.sh"
grep -Eq 'high-risk-tenant-nodepool|고위험.*RuntimeClass|고위험.*노드풀' "$AGENTS" \
  || fail "AGENTS must mention high-risk RuntimeClass/nodepool"
grep -q 'high-risk-tenant-nodepool\|check-high-risk-tenant-nodepool' "$DESIGN" \
  || fail "mcp-invoke DESIGN must link high-risk nodepool policy"

node "$PLACE_TEST" || fail "high-risk-placement.selftest.js failed"

ok "high-risk tenant RuntimeClass + dedicated node-pool policy"
echo "check-high-risk-tenant-nodepool: PASS"
