#!/usr/bin/env bash
# V3.3 gate: sandbox egress NP manifests + offline simulator (no cluster required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/egress-block-verify.md"
NP="$ROOT/deploy/k8s/sandbox-egress/networkpolicy-sandbox-egress.yaml"
KUST="$ROOT/deploy/k8s/sandbox-egress/kustomization.yaml"
RC="$ROOT/deploy/k8s/sandbox-egress/runtimeclass-gvisor.yaml"
PROBE="$ROOT/deploy/k8s/sandbox-egress/smoke-probe.js"
EVAL="$ROOT/services/sandbox-egress/evaluate-egress.js"
EVAL_TEST="$ROOT/services/sandbox-egress/evaluate-egress.selftest.js"
ALLOW="$ROOT/services/mcp-invoke/nodejs/egress-allowlist.js"
ALLOW_TEST="$ROOT/services/mcp-invoke/nodejs/egress-allowlist.selftest.js"
ISOLATION_DOC="$ROOT/deploy/docs/mcp-bundle-isolation.md"
ISOLATION_SH="$ROOT/deploy/scripts/check-mcp-bundle-isolation.sh"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
DESIGN="$ROOT/services/mcp-invoke/DESIGN.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$NP" ]] || fail "missing $NP"
[[ -f "$KUST" ]] || fail "missing $KUST"
[[ -f "$RC" ]] || fail "missing $RC"
[[ -f "$PROBE" ]] || fail "missing $PROBE"
[[ -f "$EVAL" ]] || fail "missing $EVAL"
[[ -f "$ALLOW" ]] || fail "missing $ALLOW"

grep -q 'aura.swfactory.io/sandbox' "$NP" || fail "NP must select sandbox pods"
grep -q 'policyTypes' "$NP" || fail "NP must declare policyTypes"
grep -q 'Egress' "$NP" || fail "NP must be Egress-only policy"
grep -q 'app: nats' "$NP" || fail "NP must allow NATS"
grep -q 'aura.db/role: pooler' "$NP" || fail "NP must allow Pooler"
grep -q 'aura-llm-gateway' "$NP" || fail "NP must allow LLM Gateway"
grep -q 'aura-content' "$NP" || fail "NP must allow object store"
grep -q 'kube-dns' "$NP" || fail "NP must allow DNS"
grep -q 'aura-mcp-proxy' "$NP" || fail "NP must document MCP proxy path"
if grep -E 'egress:\s*\[\s*\{\s*\}\s*\]' "$NP" || grep -q '0.0.0.0/0' "$NP"; then
  fail "NP must not open internet (no [{}] or 0.0.0.0/0)"
fi

grep -q 'networkpolicy-sandbox-egress.yaml' "$KUST" || fail "kustomization must include sandbox NP"
grep -q 'handler: runsc' "$RC" || fail "RuntimeClass gvisor must use runsc"

grep -q 'egress-block-verify' "$ISOLATION_DOC" || fail "mcp-bundle-isolation must link egress-block-verify"
grep -q '후속 child.*Egress 차단' "$ISOLATION_DOC" && fail "mcp-bundle-isolation must drop 후속-only egress note" || true

[[ -f "$ARCH" ]] || fail "missing $ARCH"
grep -q 'egress-block-verify' "$ARCH" || fail "ARCHITECTURE must reference egress-block-verify"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*Egress 차단 검증' "$ROADMAP" || fail "ROADMAP egress verify checkbox must be [x]"

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
grep -q 'egress-block-verify\|check-egress-block-verify' "$DESIGN" || fail "mcp-invoke DESIGN must link egress verify"

[[ -f "$SETUP" ]] || fail "missing $SETUP"
grep -q 'check-egress-block-verify' "$SETUP" || fail "SETUP must name check-egress-block-verify.sh"

[[ -f "$AGENTS" ]] || fail "missing $AGENTS"
grep -q 'check-egress-block-verify\|egress-block-verify' "$AGENTS" || fail "AGENTS must mention egress-block-verify"

node "$EVAL_TEST" || fail "evaluate-egress.selftest.js failed"
node "$ALLOW_TEST" || fail "egress-allowlist.selftest.js failed"
node "$PROBE" || fail "smoke-probe.js failed"

bash "$ISOLATION_SH" || fail "check-mcp-bundle-isolation.sh must stay green"

if [[ "${AURA_EGRESS_LIVE:-0}" == "1" ]] && command -v kubectl >/dev/null 2>&1; then
  ok "AURA_EGRESS_LIVE=1 — optional apply skipped unless cluster labels match doc"
fi

ok "sandbox egress NP + offline simulator"
echo "check-egress-block-verify: PASS"