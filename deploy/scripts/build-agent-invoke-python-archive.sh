#!/usr/bin/env bash
# Build Fission deployment archive for agent_invoke python (M3.6).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/services/agent-invoke/python"
OUT_DIR="$ROOT/deploy/k8s/agent-invoke-py"
OUT="$OUT_DIR/archive.zip"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$SRC/handler.py" "$STAGE/"
cp "$SRC/run_turn.py" "$STAGE/" 2>/dev/null || true
cp "$SRC/bundle_turn.py" "$STAGE/" 2>/dev/null || true
cp "$ROOT/services/object-store/get_object.py" "$STAGE/"
cp "$ROOT/services/object-store/bundle_cache.py" "$STAGE/"
cp "$ROOT/services/object-store/bundle_zip.py" "$STAGE/"
cp "$SRC/requirements.txt" "$STAGE/" 2>/dev/null || true
# Fission python-fastapi-env entry: handler.main(request) (Function package.functionName).
(
  cd "$STAGE"
  if [[ "${BUILD_INSTALL_DEPS:-0}" == "1" ]] && [[ -f requirements.txt ]] && command -v pip3 >/dev/null 2>&1; then
    pip3 install -r requirements.txt -t "$STAGE" >/dev/null 2>&1 || true
  fi
  rm -f "$OUT"
  zip -qr "$OUT" .
)
echo "OK: wrote $OUT ($(wc -c <"$OUT") bytes)"
