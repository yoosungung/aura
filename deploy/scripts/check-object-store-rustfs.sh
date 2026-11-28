#!/usr/bin/env bash
# Static gate: aura-content RustFS manifest names. Does not apply or GetObject.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUSTFS="$ROOT/deploy/k8s/rustfs"
DESIGN="$ROOT/services/object-store/DESIGN.md"
ARCH="$ROOT/ARCHITECTURE.md"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DESIGN" ]] || fail "missing object-store DESIGN"
[[ -f "$RUSTFS/statefulset.yaml" ]] || fail "missing rustfs statefulset"
[[ -f "$RUSTFS/secret.yaml" ]] || fail "missing secret.yaml template"
grep -q 'BUNDLE_CACHE_MAX_BYTES' "$DESIGN" || fail "DESIGN must name the byte cap"
grep -q '33554432' "$DESIGN" || fail "DESIGN must record 33554432"
grep -q 'replicas: 1' "$RUSTFS/statefulset.yaml" || fail "rustfs must be single node"
grep -q 'rustfs/rustfs:' "$RUSTFS/statefulset.yaml" || fail "rustfs image pin missing"
grep -q 'aura-content' "$RUSTFS/bootstrap.sh" || fail "bootstrap must create aura-content"
grep -q 'aura-object-store-creds' "$RUSTFS/bootstrap.sh" || fail "bootstrap must upsert Secret"
grep -q 'rustfs-root' "$RUSTFS/bootstrap.sh" || fail "bootstrap must ensure rustfs-root"
if grep -Eq '^[[:space:]]*-[[:space:]]*secret\.yaml[[:space:]]*$' "$RUSTFS/kustomization.yaml"; then
  fail "kustomization must not apply secret.yaml (wipes live keys)"
fi
if grep -REq 'aura-pg' "$RUSTFS"; then
  fail "rustfs manifests must not provision Barman bucket aura-pg"
fi
if [[ -d "$ROOT/deploy/k8s/garage" ]]; then
  fail "deploy/k8s/garage must be removed (RustFS solo)"
fi
grep -q 'name: aura-object-store-creds' "$RUSTFS/secret.yaml" || fail "secret name"
grep -q 'ACCESS_KEY_ID' "$RUSTFS/secret.yaml" || fail "secret ACCESS_KEY_ID"
grep -q 'ACCESS_SECRET_KEY' "$RUSTFS/secret.yaml" || fail "secret ACCESS_SECRET_KEY"
grep -q 'AURA_S3_ENDPOINT' "$RUSTFS/configmap.yaml" || fail "config AURA_S3_ENDPOINT"
grep -q 'rustfs.aura.svc.cluster.local' "$RUSTFS/configmap.yaml" || fail "endpoint must be rustfs"
grep -q 'AURA_S3_REGION' "$RUSTFS/configmap.yaml" || fail "config AURA_S3_REGION"
if grep -q 'garage.aura.svc' "$RUSTFS/configmap.yaml"; then
  fail "config must not point at garage"
fi
grep -q 'GetObject' "$ARCH" || fail "ARCHITECTURE §8 must mention GetObject"
grep -Eqi 'RustFS' "$ARCH" || fail "ARCHITECTURE must name RustFS"
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
READER="$ROOT/services/object-store/get-object.js"
[[ -f "$READER" ]] || fail "missing shared get-object reader"
grep -Eq 'assertBundleUri|s3://aura-content' "$READER" || fail "get-object must validate aura-content URIs"
grep -Eq 'sha256|createHash' "$READER" || fail "get-object must checksum payloads"
ok "rustfs manifest names + function env + shared GetObject reader"
echo "check-object-store-rustfs: PASS"
