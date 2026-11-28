#!/usr/bin/env bash
# M3 static gate: LLM Gateway min + Function egress-only-via-gateway (ARCHITECTURE §9.4).
# Exit 0 on PASS. Non-goals: live provider keys · Fallback/billing dashboard · NATS mTLS · F1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/llm-gateway.md"
DESIGN="$ROOT/services/llm-gateway/DESIGN.md"
CLIENT="$ROOT/services/llm-gateway/client.js"
SELFTEST="$ROOT/services/llm-gateway/gateway.selftest.js"
RS_LIB="$ROOT/services/llm-gateway/rs/src/lib.rs"
RS_MAIN="$ROOT/services/llm-gateway/rs/src/main.rs"
RS_DF="$ROOT/services/llm-gateway/rs/Dockerfile"
DEP="$ROOT/deploy/k8s/llm-gateway/deployment.yaml"
CM="$ROOT/deploy/k8s/llm-gateway/providers-configmap.yaml"
SVC="$ROOT/deploy/k8s/llm-gateway/service.yaml"
KUST="$ROOT/deploy/k8s/llm-gateway/kustomization.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"
EGRESS_DOC="$ROOT/deploy/docs/egress-block-verify.md"
NP="$ROOT/deploy/k8s/sandbox-egress/networkpolicy-sandbox-egress.yaml"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$CLIENT" ]] || fail "missing $CLIENT"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$RS_LIB" ]] || fail "missing Rust lib"
[[ -f "$RS_MAIN" ]] || fail "missing Rust main"
[[ -f "$RS_DF" ]] || fail "missing llm-gateway rs/Dockerfile"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$CM" ]] || fail "missing $CM"
[[ -f "$SVC" ]] || fail "missing $SVC"
[[ -f "$KUST" ]] || fail "missing $KUST"

grep -q 'assertFunctionLlmEgress\|provider_direct_forbidden' "$CLIENT" \
  || fail "client must assertFunctionLlmEgress / provider_direct_forbidden"
grep -q 'api.openai.com' "$CLIENT" || fail "client must blocklist api.openai.com"
grep -q 'aura-llm-gateway' "$CLIENT" || fail "client must allow aura-llm-gateway"
grep -q 'createLlmGatewayClient' "$CLIENT" || fail "client must export createLlmGatewayClient"

grep -Eq 'chat_completions|ChatProvider' "$RS_LIB" || fail "Rust must implement chat completions"
grep -Eqi 'rate|429|rate_limited|LlmRateLimiter' "$RS_LIB" || fail "Rust must rate-limit tenants"
grep -Eqi 'cost_usd|BillingStore|UsageEntry' "$RS_LIB" || fail "Rust must log usage/cost"
grep -Eqi 'Fallback|fallback_used|all_providers_failed' "$RS_LIB" \
  || fail "Rust must implement provider Fallback"
grep -q '/v1/chat/completions' "$RS_MAIN" || fail "Rust main must expose chat completions"
grep -q '/v1/billing/usage' "$RS_MAIN" || fail "Rust main must expose billing usage"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'Function|Egress|Gateway만|gateway만' "$DOC" || fail "doc must lock Function→Gateway-only egress"
grep -q '/v1/chat/completions' "$DOC" || fail "doc must name /v1/chat/completions"
grep -q 'aura-llm-gateway' "$DOC" || fail "doc must name aura-llm-gateway"
grep -q 'llm-gateway.md' "$DESIGN" || fail "DESIGN must link llm-gateway.md"
grep -Eq 'Rust|rs/' "$DESIGN" || fail "DESIGN must name Rust image"

grep -q 'app: aura-llm-gateway' "$DEP" || fail "Deployment must label app: aura-llm-gateway"
grep -Eq 'replicas:[[:space:]]*[2-9]|replicas:[[:space:]]*[1-9][0-9]' "$DEP" \
  || fail "Deployment replicas must be ≥ 2"
grep -q 'aura-llm-gateway' "$SVC" || fail "Service must be aura-llm-gateway"
grep -q 'image: aura/llm-gateway:local' "$DEP" || fail "llm-gateway image must be aura/llm-gateway:local"
grep -q 'aura-llm-gateway-providers' "$DEP" || fail "Deployment must mount provider ConfigMap"
grep -q 'AURA_LLM_PROVIDERS_FILE' "$DEP" || fail "Deployment must set AURA_LLM_PROVIDERS_FILE"
grep -q 'providers-configmap.yaml' "$KUST" || fail "kustomization must include providers ConfigMap"
grep -q 'gemma4:e2b' "$CM" || fail "provider ConfigMap default model must be gemma4:e2b"
grep -q '"kind": "ollama"' "$CM" || fail "provider ConfigMap default kind must be ollama"
grep -q '"embeddings"' "$CM" || fail "provider ConfigMap must include embeddings block"
grep -q 'embeddinggemma-2:270m-mxfp8-text' "$CM" \
  || fail "provider ConfigMap embeddings model must be embeddinggemma-2:270m-mxfp8-text"
grep -q '/v1/embeddings' "$DOC" || fail "doc must name /v1/embeddings"
grep -q 'embeddings' "$DESIGN" || fail "DESIGN must mention embeddings"
for kind in stub ollama openai vllm sglang; do
  grep -q "$kind" "$CM" || fail "ConfigMap must allow kind $kind"
  grep -q "$kind" "$DESIGN" || fail "DESIGN must name kind $kind"
done
grep -q '8000' "$DESIGN" || fail "DESIGN must name vllm port 8000"
grep -q '30000' "$DESIGN" || fail "DESIGN must name sglang port 30000"
grep -q 'dev.orbstack.icon=' "$RS_DF" || fail "llm-gateway image must set dev.orbstack.icon"
grep -q 'aura-llm-gateway' "$RS_DF" || fail "rs Dockerfile must build aura-llm-gateway"
if grep -Eq 'node -e|node:22-alpine' "$DEP"; then
  fail "llm-gateway must not use node:22-alpine / node -e stub"
fi
grep -Eq 'aura/llm-gateway:local' "$DESIGN" || fail "DESIGN must name baked aura/llm-gateway image"
if grep -Eqi 'MessageQueueTrigger|kind:[[:space:]]*ScaledObject' "$DEP" "$SVC" "$KUST"; then
  fail "llm-gateway must not use MQT/ScaledObject"
fi

grep -Eq 'llm-gateway\.md|services/llm-gateway' "$ARCH" \
  || fail "ARCHITECTURE must link llm-gateway"
grep -Eq '\[x\].*LLM Gateway|\[x\].*llm-gateway' "$ROADMAP" \
  || fail "ROADMAP LLM Gateway checkbox must be [x]"
grep -q 'check-llm-gateway' "$SETUP" || fail "SETUP must name check-llm-gateway.sh"
grep -q 'llm-gateway' "$AGENTS" || fail "AGENTS must mention llm-gateway"

[[ -f "$NP" ]] || fail "missing sandbox NP"
grep -q 'aura-llm-gateway' "$NP" || fail "sandbox NP must allow aura-llm-gateway"
grep -Eqi 'llm-gateway|LLM Gateway' "$EGRESS_DOC" || fail "egress doc must reference LLM Gateway"

node "$SELFTEST" || fail "gateway.selftest.js failed"
(cd "$ROOT" && cargo test -p aura-llm-gateway --quiet) || fail "cargo test -p aura-llm-gateway failed"

ok "llm-gateway client egress guard + Rust RL/circuit + Deployment≥2"
echo "check-llm-gateway: PASS"
