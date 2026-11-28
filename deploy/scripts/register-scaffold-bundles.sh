#!/usr/bin/env bash
# Register four tenant scaffolds via control-admin API (presign→PUT→sources→activate).
# In-cluster DNS only: http://aura-control-admin.aura.svc.cluster.local:8080
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
ADMIN_BASE="${ADMIN_BASE:-http://aura-control-admin.${NS}.svc.cluster.local:8080}"
BEARER="${AURA_ADMIN_BEARER:-ops-dev-token}"
TENANT_ID="${AURA_TENANT_ID:-11111111-1111-4111-8111-111111111111}"
TENANT_NAME="${AURA_TENANT_NAME:-scaffold-lab}"
CURL_IMAGE="${SMOKE_GATEWAY_CURL_IMAGE:-curlimages/curl:8.5.0}"
NODE_IMAGE="${REGISTER_NODE_IMAGE:-node:22-alpine}"
POD=""
STAGE=""

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

need kubectl
need node
need python3

cleanup() {
  if [[ -n "${POD:-}" ]]; then
    kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  if [[ -n "${STAGE:-}" && -d "${STAGE:-}" ]]; then
    rm -rf "$STAGE"
  fi
}
trap cleanup EXIT

echo "== 0 sync scaffold zips =="
(cd "$ROOT/services/admin-ui" && node scripts/sync-scaffolds.cjs) || fail "sync-scaffolds failed"
ZIP_DIR="$ROOT/services/admin-ui/public/scaffolds"
[[ -f "$ZIP_DIR/mcp-nodejs.zip" ]] || fail "missing mcp-nodejs.zip"
[[ -f "$ZIP_DIR/mcp-python.zip" ]] || fail "missing mcp-python.zip"
[[ -f "$ZIP_DIR/agent-nodejs.zip" ]] || fail "missing agent-nodejs.zip"
[[ -f "$ZIP_DIR/agent-python.zip" ]] || fail "missing agent-python.zip"
ok "scaffold zips ready"

echo "== 1 control-admin Ready =="
kubectl -n "$NS" rollout status deploy/aura-control-admin --timeout=180s \
  || fail "aura-control-admin not Ready"
ok "aura-control-admin Ready · base=$ADMIN_BASE"

STAGE=$(mktemp -d)
cp "$ZIP_DIR/mcp-nodejs.zip" "$STAGE/mcp-nodejs.zip"
cp "$ZIP_DIR/mcp-python.zip" "$STAGE/mcp-python.zip"
cp "$ZIP_DIR/agent-nodejs.zip" "$STAGE/agent-nodejs.zip"
cp "$ZIP_DIR/agent-python.zip" "$STAGE/agent-python.zip"

cat > "$STAGE/register.js" <<'JS'
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ADMIN_BASE = process.env.ADMIN_BASE;
const BEARER = process.env.BEARER;
const TENANT_ID = process.env.TENANT_ID;
const TENANT_NAME = process.env.TENANT_NAME || 'scaffold-lab';
const DIR = process.env.BUNDLE_DIR || '.';

function sha256Prefixed(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

async function api(method, p, body) {
  const res = await fetch(`${ADMIN_BASE}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${BEARER}`,
      'x-aura-tenant-id': TENANT_ID,
      'content-type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function registerOne(spec) {
  const bytes = fs.readFileSync(path.join(DIR, spec.zip));
  const checksum = sha256Prefixed(bytes);
  console.log(`== ${spec.kind}/${spec.name}@${spec.version} ==`);

  const signed = await api('POST', '/v1/bundles/presign', {
    kind: spec.kind,
    name: spec.name,
    version: spec.version,
  });
  if (signed.status >= 400) {
    throw new Error(`presign ${signed.status} ${JSON.stringify(signed.body)}`);
  }
  const upload = await fetch(signed.body.upload_url, {
    method: 'PUT',
    headers: signed.body.headers || {},
    body: bytes,
  });
  if (!upload.ok) {
    const t = await upload.text();
    throw new Error(`upload ${upload.status} ${t.slice(0, 200)}`);
  }
  console.log('OK_UPLOAD');

  const created = await api('POST', '/v1/sources', {
    kind: spec.kind,
    name: spec.name,
    version: spec.version,
    entrypoint: 'main:factory',
    bundle_uri: signed.body.bundle_uri,
    checksum,
    runtime: spec.runtime,
    config: spec.config || {},
  });
  if (created.status === 409) {
    console.log('OK_EXISTS_409');
    const listed = await api('GET', `/v1/sources/${spec.kind}/${spec.name}`);
    const row = (listed.body.sources || []).find((s) => s.version === spec.version);
    if (!row) throw new Error('version_exists but list miss');
    if (row.status === 'active') {
      console.log(`OK_ACTIVE id=${row.id}`);
      return row.id;
    }
    const act = await api('POST', `/v1/sources/${row.id}/activate`);
    if (act.status >= 400) {
      throw new Error(`activate-existing ${act.status} ${JSON.stringify(act.body)}`);
    }
    console.log(`OK_ACTIVE id=${row.id}`);
    return row.id;
  }
  if (created.status >= 400) {
    throw new Error(`create ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.source && created.body.source.id;
  if (!id) throw new Error('missing source.id');
  console.log(`OK_PENDING id=${id}`);

  const act = await api('POST', `/v1/sources/${id}/activate`);
  if (act.status >= 400) {
    throw new Error(`activate ${act.status} ${JSON.stringify(act.body)}`);
  }
  console.log(`OK_ACTIVE id=${id}`);
  return id;
}

async function main() {
  const hz = await fetch(`${ADMIN_BASE}/healthz`);
  if (!hz.ok) throw new Error(`healthz ${hz.status}`);
  console.log('OK_HEALTHZ');

  const tenant = await api('POST', '/v1/tenants', {
    id: TENANT_ID,
    display_name: TENANT_NAME,
  });
  if (tenant.status >= 400) {
    throw new Error(`tenant ${tenant.status} ${JSON.stringify(tenant.body)}`);
  }
  console.log('OK_TENANT');

  const specs = [
    {
      zip: 'mcp-nodejs.zip',
      kind: 'mcp',
      name: 'naver-search',
      version: '1',
      runtime: 'nodejs',
      config: { service: 'webkr', display: '10' },
    },
    {
      zip: 'mcp-python.zip',
      kind: 'mcp',
      name: 'weather',
      version: '1',
      runtime: 'python',
      config: { forecast_days: '1', timezone: 'auto' },
    },
    {
      zip: 'agent-nodejs.zip',
      kind: 'agent',
      name: 'research-agent',
      version: '1-nodejs',
      runtime: 'nodejs',
      config: {
        system_prompt:
          'You are a scaffold research agent. Use naver_search and weather tools.',
        tools: [
          { server: 'naver-search', version: '1', name: 'naver_search' },
          { server: 'weather', version: '1', name: 'weather' },
        ],
      },
    },
    {
      zip: 'agent-python.zip',
      kind: 'agent',
      name: 'research-agent',
      version: '1-python',
      runtime: 'python',
      config: {
        system_prompt:
          'You are a scaffold research agent. Use naver_search and weather tools.',
        tools: [
          { server: 'naver-search', version: '1', name: 'naver_search' },
          { server: 'weather', version: '1', name: 'weather' },
        ],
      },
    },
  ];

  for (const spec of specs) {
    await registerOne(spec);
  }
  console.log('REGISTER_PASS');
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
JS

POD="aura-register-scaffolds-$$"
kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
kubectl -n "$NS" run "$POD" --restart=Never --image="$NODE_IMAGE" \
  --command -- sleep 600 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=90s >/dev/null

kubectl -n "$NS" cp "$STAGE/register.js" "$POD:/tmp/register.js"
kubectl -n "$NS" cp "$STAGE/mcp-nodejs.zip" "$POD:/tmp/mcp-nodejs.zip"
kubectl -n "$NS" cp "$STAGE/mcp-python.zip" "$POD:/tmp/mcp-python.zip"
kubectl -n "$NS" cp "$STAGE/agent-nodejs.zip" "$POD:/tmp/agent-nodejs.zip"
kubectl -n "$NS" cp "$STAGE/agent-python.zip" "$POD:/tmp/agent-python.zip"

echo "== 2 register via control-admin API =="
OUT=$(kubectl -n "$NS" exec "$POD" -- \
  env ADMIN_BASE="$ADMIN_BASE" BEARER="$BEARER" TENANT_ID="$TENANT_ID" \
      TENANT_NAME="$TENANT_NAME" BUNDLE_DIR=/tmp \
  node /tmp/register.js)
printf '%s\n' "$OUT"
echo "$OUT" | grep -q REGISTER_PASS || fail "missing REGISTER_PASS"
ok "four scaffolds registered (or already active)"

echo
echo "register-scaffold-bundles: PASS"
