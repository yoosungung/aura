#!/usr/bin/env bash
# M2 static gate: services/memory embed DESIGN + MQT + short_term skip + set_config(..., true).
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESIGN="$ROOT/services/memory/DESIGN.md"
EMBED_DIR="$ROOT/services/memory/embed"
K8S_DIR="$ROOT/deploy/k8s/memory-embed"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -d "$EMBED_DIR" ]] || fail "missing $EMBED_DIR"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

# DESIGN contracts
grep -q 'aura.tasks.memory.embed' "$DESIGN" || fail "DESIGN must name aura.tasks.memory.embed"
grep -q 'aura.events.memory.embedded' "$DESIGN" || fail "DESIGN must name aura.events.memory.embedded"
grep -q 'aura.events.memory.embed.error' "$DESIGN" || fail "DESIGN must name embed.error"
grep -Eqi 'short_term' "$DESIGN" || fail "DESIGN must mention short_term"
grep -Eqi '스킵|skip|skipped_short_term' "$DESIGN" || fail "DESIGN must require short_term skip"
grep -Eq "set_config\('app\.tenant_id',\s*\$1,\s*true\)|set_config\('app\.tenant_id',\s*.*,\s*true\)" "$DESIGN" \
  || fail "DESIGN must require set_config('app.tenant_id', …, true)"
grep -Eqi 'episodic|long_term|semantic' "$DESIGN" || fail "DESIGN must name embeddable types"
grep -Eqi 'HNSW|BM25|content_tsv' "$DESIGN" || fail "DESIGN must mention HNSW/BM25 path"
grep -q 'aura-pg-pooler' "$DESIGN" || fail "DESIGN must require pooler DSN (aura-pg-pooler)"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q '## Commands' "$DESIGN" || fail "DESIGN must include ## Commands"

HANDLER="$EMBED_DIR/handler.js"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"

grep -q 'skipped_short_term\|short_term' "$HANDLER" || fail "handler must skip short_term"
grep -q 'withTenantTx\|with_tenant_tx' "$HANDLER" || fail "handler.js must use withTenantTx"
grep -q '/v1/embeddings' "$HANDLER" || fail "handler must call Gateway /v1/embeddings"
grep -q 'assertFunctionLlmEgress\|llm-gateway/client' "$HANDLER" \
  || fail "handler must egress via llm-gateway client guard"
grep -q 'embedding_dims_mismatch' "$HANDLER" || fail "handler must guard embedding dims"
grep -q "via: 'llm_gateway'" "$HANDLER" || fail "handler must record via llm_gateway"
LAB_DOC="$ROOT/deploy/docs/memory-embed-ollama-lab.md"
[[ -f "$LAB_DOC" ]] || fail "missing $LAB_DOC"
grep -q 'memory-embed-ollama-lab.md' "$DESIGN" || fail "DESIGN must link memory-embed-ollama-lab.md"
grep -Eq "set_config\('app\.tenant_id'" "$ROOT/services/memory/store/tenant-tx.js" \
  || fail "tenant-tx.js must call set_config"
if grep -Eq "set_config\([^)]*,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$HANDLER"; then
  fail "embed source must not use set_config(..., false) or SET app.tenant_id"
fi
# short_term path must not open a transaction in handler source (skip before withTenantTx)
grep -Eq "memoryType === 'short_term'|memory_type === 'short_term'" "$HANDLER" \
  || fail "handler must branch on short_term before embed"

node "$EMBED_DIR/handler.selftest.js" || fail "handler.selftest.js failed"

# MQT manifests (§3.2)
MQT="$K8S_DIR/mqt.yaml"
FN="$K8S_DIR/function.yaml"
PKG="$K8S_DIR/package.yaml"
EMBED_JS="$K8S_DIR/embed.js"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$FN" ]] || fail "missing $FN"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$EMBED_JS" ]] || fail "missing $EMBED_JS"

CM_LAB="$K8S_DIR/configmap-lab.yaml"
[[ -f "$CM_LAB" ]] || fail "missing $CM_LAB"
grep -q 'aura-memory-embed-lab' "$FN" || fail "function.yaml must reference aura-memory-embed-lab ConfigMap"
grep -q 'embeddinggemma-2:270m-mxfp8-text' "$CM_LAB" \
  || fail "lab ConfigMap must set embeddinggemma-2:270m-mxfp8-text"
grep -q 'AURA_LLM_GATEWAY_URL' "$CM_LAB" || fail "lab ConfigMap must set AURA_LLM_GATEWAY_URL"
grep -q '768' "$CM_LAB" || fail "lab ConfigMap dims must be 768"
grep -q 'configmap-lab.yaml' "$K8S_DIR/kustomization.yaml" \
  || fail "kustomization must include configmap-lab.yaml"
grep -q '/v1/embeddings' "$EMBED_JS" || fail "embed.js must call Gateway /v1/embeddings"
grep -q 'aura-memory-embed-lab' "$EMBED_JS" || fail "embed.js must read lab ConfigMap mount"

grep -Eq 'set_config\('\''app\.tenant_id'\'',\s*\$1,\s*true\)' "$EMBED_JS" \
  || fail "embed.js Package entry must call set_config(..., true)"
grep -q 'skipped_short_term' "$EMBED_JS" || fail "embed.js must skip short_term"

python3 - "$PKG" "$EMBED_JS" <<'PY' || fail "package.yaml literal != embed.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: package literal matches embed.js")
PY

grep -q 'kind: MessageQueueTrigger' "$MQT" || fail "mqt.yaml must be MessageQueueTrigger"
grep -q 'aura.tasks.memory.embed' "$MQT" || fail "mqt topic must be aura.tasks.memory.embed"
grep -q 'aura.events.memory.embedded' "$MQT" || fail "mqt respTopic must be aura.events.memory.embedded"
grep -q 'aura.events.memory.embed.error' "$MQT" || fail "mqt errorTopic must be aura.events.memory.embed.error"
grep -q 'aura_memory_embed' "$MQT" || fail "mqt consumer must be aura_memory_embed"
grep -q 'AURA_TASKS' "$MQT" || fail "mqt stream must be AURA_TASKS"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "mqt minReplicaCount must be 0 (scale-to-zero)"
grep -Eq 'mqtkind:[[:space:]]*keda|messageQueueType:[[:space:]]*nats-jetstream' "$MQT" \
  || fail "mqt must be nats-jetstream + keda"

# ROADMAP checkbox
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*embed Function \(MQT\).*short_term' "$ROADMAP" \
  || fail "ROADMAP M2 embed Function checkbox must be [x]"

ok "services/memory embed DESIGN + MQT + short_term skip"
echo "check-memory-embed: PASS"
