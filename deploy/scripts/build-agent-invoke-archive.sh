#!/usr/bin/env bash
# Build Fission source archive for agent_invoke (nodejs · M3.5/M3.6 layout).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/services/agent-invoke/nodejs"
OUT_DIR="$ROOT/deploy/k8s/agent-invoke"
OUT="$OUT_DIR/archive.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$SRC/handler.js" "$STAGE/"
cp "$SRC/run-turn-create-agent.js" "$STAGE/" 2>/dev/null || true
cp "$SRC/bundle-turn.js" "$STAGE/" 2>/dev/null || true
cp "$SRC/llm-gateway-model.js" "$STAGE/" 2>/dev/null || true
cp "$SRC/checkpoints.js" "$STAGE/" 2>/dev/null || true
cp "$SRC/nats-deps.js" "$STAGE/" 2>/dev/null || true
cp "$ROOT/services/object-store/get-object.js" "$STAGE/"
cp "$ROOT/services/object-store/bundle-cache.js" "$STAGE/"
cp "$ROOT/services/object-store/bundle-zip.js" "$STAGE/"
cp "$SRC/package.json" "$STAGE/"
# LLM egress client (relative require path rewritten in llm-gateway-model for archive: ./llm-gateway-client.js)
cp "$ROOT/services/llm-gateway/clients/client.js" "$STAGE/llm-gateway-client.js"

(
  cd "$STAGE"
  # Opt-in: BUILD_INSTALL_DEPS=1 npm install into zip (large). Default = sources only.
  if [[ "${BUILD_INSTALL_DEPS:-0}" == "1" ]] && [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
  fi
  rm -f "$OUT"
  zip -qr "$OUT" . -x 'node_modules/*'
)
echo "OK: wrote $OUT ($(wc -c <"$OUT") bytes)"
