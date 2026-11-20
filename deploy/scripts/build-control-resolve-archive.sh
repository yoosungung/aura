#!/usr/bin/env bash
# Build Fission package zip for aura-control-resolve (poolmgr sync).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/deploy/k8s/control-resolve/archive.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$ROOT/services/control/bridge.js" "$STAGE/"
cp "$ROOT/services/control/resolve.js" "$STAGE/"
cat >"$STAGE/index.js" <<'JS'
'use strict';
const { handleResolve } = require('./bridge');

function parseBody(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  text = text.trim();
  if (!text) return {};
  return JSON.parse(text);
}

module.exports = async function (context) {
  let req;
  try {
    const raw =
      context && context.request && context.request.body != null
        ? context.request.body
        : '';
    req = parseBody(raw);
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({
        type: 'control.resolve.error',
        ok: false,
        error: 'invalid_json',
        detail: String(err && err.message),
        subject: 'aura.rpc.control.resolve',
      }),
    };
  }
  const out = await handleResolve(req);
  const ok = out && out.ok === true;
  return {
    status: ok ? 200 : 400,
    body: JSON.stringify(out),
  };
};
JS
cat >"$STAGE/package.json" <<'JSON'
{"name":"aura-control-resolve","private":true,"main":"index.js"}
JSON

(cd "$STAGE" && rm -f "$OUT" && zip -qr "$OUT" .)
echo "OK: wrote $OUT"
