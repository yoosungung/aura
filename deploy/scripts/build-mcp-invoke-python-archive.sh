#!/usr/bin/env bash
# Build Fission deployment archive for mcp_invoke python (M3.6).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/services/mcp-invoke/python"
OUT="$ROOT/deploy/k8s/mcp-invoke-py/archive.zip"
mkdir -p "$ROOT/deploy/k8s/mcp-invoke-py" "$ROOT/deploy/k8s/mcp-invoke-rpc-py"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$SRC/handler.py" "$STAGE/"
cp "$SRC/factory.py" "$STAGE/"
cp "$ROOT/services/object-store/get_object.py" "$STAGE/"
cp "$ROOT/services/object-store/bundle_cache.py" "$STAGE/"
cp "$ROOT/services/object-store/bundle_zip.py" "$STAGE/"
cp "$SRC/requirements.txt" "$STAGE/" 2>/dev/null || true
(
  cd "$STAGE"
  if [[ "${BUILD_INSTALL_DEPS:-0}" == "1" ]] && [[ -f requirements.txt ]] && command -v pip3 >/dev/null 2>&1; then
    pip3 install -r requirements.txt -t "$STAGE" >/dev/null 2>&1 || true
  fi
  rm -f "$OUT"
  zip -qr "$OUT" .
)
cp "$OUT" "$ROOT/deploy/k8s/mcp-invoke-rpc-py/archive.zip"
echo "OK: wrote $OUT and mcp-invoke-rpc-py/archive.zip"
