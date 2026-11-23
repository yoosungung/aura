#!/usr/bin/env bash
# Static gate: aura-content Garage manifest names. Does not apply or GetObject.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GARAGE="$ROOT/deploy/k8s/garage"
DESIGN="$ROOT/services/object-store/DESIGN.md"
ARCH="$ROOT/ARCHITECTURE.md"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing object-store DESIGN"
[[ -f "$GARAGE/statefulset.yaml" ]] || fail "missing garage statefulset"
[[ -f "$GARAGE/secret.yaml" ]] || fail "missing secret.yaml template"
grep -q 'BUNDLE_CACHE_MAX_BYTES' "$DESIGN" || fail "DESIGN must name the byte cap"
grep -q '33554432' "$DESIGN" || fail "DESIGN must record 33554432"
grep -q 'replicas: 1' "$GARAGE/statefulset.yaml" || fail "garage must be single node"
grep -q 'aura-content' "$GARAGE/bootstrap.sh" || fail "bootstrap must create aura-content"
grep -q 'aura-object-store-creds' "$GARAGE/bootstrap.sh" || fail "bootstrap must upsert Secret"
if grep -Eq '^[[:space:]]*-[[:space:]]*secret\.yaml[[:space:]]*$' "$GARAGE/kustomization.yaml"; then
  fail "kustomization must not apply secret.yaml (wipes live keys)"
fi
if grep -REq 'aura-pg' "$GARAGE"; then
  fail "garage manifests must not provision Barman bucket aura-pg"
fi
grep -q 'name: aura-object-store-creds' "$GARAGE/secret.yaml" || fail "secret name"
grep -q 'ACCESS_KEY_ID' "$GARAGE/secret.yaml" || fail "secret ACCESS_KEY_ID"
grep -q 'ACCESS_SECRET_KEY' "$GARAGE/secret.yaml" || fail "secret ACCESS_SECRET_KEY"
grep -q 'AURA_S3_ENDPOINT' "$GARAGE/configmap.yaml" || fail "config AURA_S3_ENDPOINT"
grep -q 'AURA_S3_REGION' "$GARAGE/configmap.yaml" || fail "config AURA_S3_REGION"
grep -q 'GetObject' "$ARCH" || fail "ARCHITECTURE §8 must mention GetObject"
for fn in \
  agent-invoke/function.yaml \
  agent-invoke-py/function.yaml \
  mcp-invoke/function.yaml \
  mcp-invoke-py/function.yaml \
  mcp-invoke-rpc/function.yaml \
  mcp-invoke-rpc-py/function.yaml
do
  grep -q 'aura-object-store-creds' "$ROOT/deploy/k8s/$fn" || fail "$fn missing secret"
  grep -q 'name: aura-s3' "$ROOT/deploy/k8s/$fn" || fail "$fn missing aura-s3"
done
ADMIN="$ROOT/deploy/k8s/control-admin/deployment.yaml"
grep -q 'AURA_S3_ENDPOINT' "$ADMIN" || fail "control-admin missing AURA_S3_ENDPOINT"
grep -q 'aura-object-store-creds' "$ADMIN" || fail "control-admin missing secret"
ENTRY="$ROOT/services/control/admin-entrypoint.js"
if grep -q 'return null' "$ENTRY"; then
  fail "production getObject must not return null"
fi
grep -q 'object-store/get-object' "$ENTRY" || fail "entrypoint must use the shared reader"
ok "garage manifest names + function env + activate reader"
echo "check-object-store-garage: PASS"
