#!/usr/bin/env bash
# Build Fission source archive for mcp_invoke (nodejs · M3.5/M3.6 layout).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/services/mcp-invoke/nodejs"
OUT="$ROOT/deploy/k8s/mcp-invoke/archive.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$SRC/handler.js" "$STAGE/"
cp "$SRC/streamable-http.js" "$STAGE/"
cp "$SRC/factory.js" "$STAGE/"
cp "$SRC/bundle-factory.js" "$STAGE/"
cp "$ROOT/services/object-store/get-object.js" "$STAGE/"
cp "$ROOT/services/object-store/bundle-cache.js" "$STAGE/"
cp "$SRC/package.json" "$STAGE/"
# Fission entry: default export is handler (RPC path via x-aura-rpc / body).
cat >"$STAGE/index.js" <<'JS'
'use strict';
module.exports = require('./handler');
JS
# Ensure package main points at index for specialize
python3 - "$STAGE/package.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text()) if p.exists() else {}
data["main"] = "index.js"
data["private"] = True
p.write_text(json.dumps(data, indent=2) + "\n")
PY

(
  cd "$STAGE"
  if [[ "${BUILD_INSTALL_DEPS:-0}" == "1" ]] && [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
  fi
  rm -f "$OUT"
  zip -qr "$OUT" . -x 'node_modules/*'
)
cp "$OUT" "$ROOT/deploy/k8s/mcp-invoke-rpc/archive.zip"
echo "OK: wrote $OUT and mcp-invoke-rpc/archive.zip"
