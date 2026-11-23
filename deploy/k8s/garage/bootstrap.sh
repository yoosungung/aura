#!/usr/bin/env bash
# Lab only. Creates bucket aura-content, app key, and upserts Secret aura-object-store-creds.
# CI does not run this. kubectl apply -k this directory does not touch the Secret.
set -euo pipefail
NS="${AURA_NAMESPACE:-aura}"
POD="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=garage -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$POD" ]] || { echo "FAIL: garage pod missing" >&2; exit 1; }
g() { kubectl -n "$NS" exec "$POD" -- /garage -c /etc/garage.toml "$@"; }
g status
# layout assign wants a hex node-id prefix, not the full id@host:port connect string.
NODE="$(g node id -q | cut -d@ -f1 | cut -c1-16)"
g layout assign -z dc1 -c 1GB "$NODE" || true
g layout apply --version 1 || true
g bucket create aura-content || true
KEY_NAME="${AURA_GARAGE_KEY_NAME:-aura-app}"
KEY_OUT="$(g key create "$KEY_NAME" 2>&1 || true)"
if ! echo "$KEY_OUT" | grep -q 'Key ID:'; then
  echo "FAIL: could not create key $KEY_NAME (secret is only shown at create time). Pick a new AURA_GARAGE_KEY_NAME." >&2
  exit 1
fi
echo "$KEY_OUT"
g bucket allow --read --write aura-content --key "$KEY_NAME"
AK="$(echo "$KEY_OUT" | awk -F': ' '/Key ID:/{print $2}' | tr -d '\r')"
SK="$(echo "$KEY_OUT" | awk -F': ' '/Secret key:/{print $2}' | tr -d '\r')"
[[ -n "$AK" && -n "$SK" ]] || { echo "FAIL: parse key output" >&2; exit 1; }
kubectl -n "$NS" create secret generic aura-object-store-creds \
  --from-literal=ACCESS_KEY_ID="$AK" \
  --from-literal=ACCESS_SECRET_KEY="$SK" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "OK: Secret aura-object-store-creds upserted. Restart consumers that mount it (e.g. aura-control-admin)."
