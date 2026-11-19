#!/usr/bin/env bash
# Build Fission source archive for mcp_invoke (M3.5 archive packaging).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/services/mcp-invoke"
OUT="$ROOT/deploy/k8s/mcp-invoke/archive.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$SRC/handler.js" "$STAGE/"
cp "$SRC/streamable-http.js" "$STAGE/"
cp "$SRC/factory.js" "$STAGE/" 2>/dev/null || true
cp "$SRC/rpc-worker.js" "$STAGE/" 2>/dev/null || true
cp "$SRC/package.json" "$STAGE/"

(
  cd "$STAGE"
  if [[ "${BUILD_INSTALL_DEPS:-0}" == "1" ]] && [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
  fi
  rm -f "$OUT"
  zip -qr "$OUT" . -x 'node_modules/*'
)
# RPC kustomize may reuse the same zip
cp "$OUT" "$ROOT/deploy/k8s/mcp-invoke-rpc/archive.zip"
echo "OK: wrote $OUT and mcp-invoke-rpc/archive.zip"
