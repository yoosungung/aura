#!/usr/bin/env bash
# Build Fission package zip for aura-memory-recall (poolmgr sync).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/deploy/k8s/memory-recall/archive.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/recall" "$STAGE/store"
cp "$ROOT/services/memory/recall/handler.js" "$STAGE/recall/"
cp "$ROOT/services/memory/recall/graph-walk.js" "$STAGE/recall/"
cp "$ROOT/services/memory/store/tenant-tx.js" "$STAGE/store/"
cat >"$STAGE/index.js" <<'JS'
'use strict';
module.exports = require('./recall/handler').handler;
JS
cat >"$STAGE/package.json" <<'JSON'
{"name":"aura-memory-recall","private":true,"main":"index.js"}
JSON

(cd "$STAGE" && rm -f "$OUT" && zip -qr "$OUT" .)
echo "OK: wrote $OUT"
