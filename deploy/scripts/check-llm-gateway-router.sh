#!/usr/bin/env bash
# M5.1 static gate: LLM Gateway aura-auto heuristic content router (ARCHITECTURE §9.4).
# Exit 0 on PASS. Non-goals: learned classifier · quality cascade · live provider keys.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/llm-gateway-router.md"
DESIGN="$ROOT/services/llm-gateway/DESIGN.md"
GW="$ROOT/services/llm-gateway/gateway.js"
ROUTER="$ROOT/services/llm-gateway/router.js"
SELFTEST="$ROOT/services/llm-gateway/gateway.selftest.js"
CM="$ROOT/deploy/k8s/llm-gateway/providers-configmap.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$GW" ]] || fail "missing $GW"
[[ -f "$ROUTER" ]] || fail "missing $ROUTER"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$CM" ]] || fail "missing $CM"

grep -Eq 'aura-auto|AUTO_MODEL|resolveRoute' "$ROUTER" \
  || fail "router.js must export aura-auto resolveRoute"
grep -Eq 'resolveRoute|route_tier|aura\.route|routing' "$GW" \
  || fail "gateway must wire resolveRoute + route meta"
grep -Eqi 'aura-auto|route_pin|route pin|content router' "$SELFTEST" \
  || fail "selftest must cover aura-auto / route pin"

grep -q 'routing' "$CM" || fail "ConfigMap must include routing.tiers"
grep -Eq 'simple|medium|complex' "$CM" || fail "ConfigMap routing must name tiers"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eq 'aura-auto|휴리스틱|heuristic' "$DOC" || fail "doc must describe aura-auto heuristic"
grep -q 'llm-gateway-router.md' "$DESIGN" || fail "DESIGN must link llm-gateway-router.md"
grep -Eq 'router\.js|aura-auto|콘텐츠 라우팅' "$DESIGN" \
  || fail "DESIGN must mention router / aura-auto"

grep -Eq 'llm-gateway-router\.md|콘텐츠 라우팅|aura-auto' "$ARCH" \
  || fail "ARCHITECTURE must link content router"
grep -Eq '\[x\].*콘텐츠 라우터|\[x\].*llm-gateway-router|\[x\].*aura-auto' "$ROADMAP" \
  || fail "ROADMAP content-router checkbox must be [x]"
grep -q 'check-llm-gateway-router' "$SETUP" \
  || fail "SETUP must name check-llm-gateway-router.sh"
grep -Eq 'llm-gateway-router|콘텐츠 라우터|aura-auto' "$AGENTS" \
  || fail "AGENTS must mention content router"

node "$SELFTEST" || fail "gateway.selftest.js failed"

ok "llm-gateway aura-auto heuristic content router"
echo "check-llm-gateway-router: PASS"
