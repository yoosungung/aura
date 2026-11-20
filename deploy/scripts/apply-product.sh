#!/usr/bin/env bash
# Apply product workloads (not deploy/dev smoke). Requires install-runtime + install-pg-pooler.
# Shared Fission Environments: async poolsize 1 / sync poolsize 2 (poolmgr).
# Sync RPC: aura-nats-rpc-bridge → router-internal:8889 → sync Functions (no per-service *-rr).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl
need python3
need zip
need unzip

apply_pkg_zip_literal() {
  local name="$1" env="$2" zip="$3" class="$4" svc="$5"
  [[ -f "$zip" ]] || { echo "FAIL: missing $zip" >&2; exit 1; }
  python3 - "$name" "$env" "$zip" "$class" "$svc" <<'PY' | kubectl apply --server-side --force-conflicts -f -
import sys, pathlib, base64
name, env, zip_path, clazz, svc = sys.argv[1:6]
lit = base64.b64encode(pathlib.Path(zip_path).read_bytes()).decode()
print(f"""apiVersion: fission.io/v1
kind: Package
metadata:
  name: {name}
  namespace: default
  labels:
    aura.runtime/class: {clazz}
    aura.service: {svc}
    app.kubernetes.io/part-of: aura
    app.kubernetes.io/name: {name}
spec:
  environment:
    name: {env}
    namespace: default
  deployment:
    type: literal
    literal: {lit}
""")
PY
  echo "OK: package $name (zip literal)"
}

echo "== build sync/async archives =="
bash "$ROOT/deploy/scripts/build-memory-recall-archive.sh"
bash "$ROOT/deploy/scripts/build-control-resolve-archive.sh"
bash "$ROOT/deploy/scripts/build-mcp-invoke-archive.sh"

echo "== shared runtime Environments =="
kubectl apply -k "$ROOT/deploy/k8s/runtime-envs"

echo "== nats-rpc-bridge ConfigMap + Deployment (ns aura) =="
STAGE_BR="$(mktemp -d)"
cleanup() { rm -rf "$STAGE_BR"; }
trap cleanup EXIT
cp "$ROOT/services/nats-rpc-bridge/bridge.js" "$STAGE_BR/"
cp "$ROOT/services/nats-rpc-bridge/package.json" "$STAGE_BR/"
kubectl -n aura create configmap aura-nats-rpc-bridge-app \
  --from-file="$STAGE_BR" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k "$ROOT/deploy/k8s/nats-rpc-bridge"

echo "== product kustomize =="
PRODUCT=(
  gateway
  llm-gateway
  memory-store
  memory-capture
  memory-embed
  memory-recall
  memory-consolidate
  memory-archive
  memory-ttl
  memory-object-gc
  control-resolve
  compliance-erase
)
for name in "${PRODUCT[@]}"; do
  echo "-- $name"
  kubectl apply -k "$ROOT/deploy/k8s/$name"
done

echo "== agent/mcp function+mqt =="
kubectl apply -f "$ROOT/deploy/k8s/agent-invoke/function.yaml" \
  -f "$ROOT/deploy/k8s/agent-invoke/mqt.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke/function.yaml" \
  -f "$ROOT/deploy/k8s/mcp-invoke/mqt.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke-rpc/function.yaml"

apply_pkg_zip_literal aura-agent-invoke aura-nodejs-async \
  "$ROOT/deploy/k8s/agent-invoke/archive.zip" async agent-invoke
apply_pkg_zip_literal aura-mcp-invoke aura-nodejs-async \
  "$ROOT/deploy/k8s/mcp-invoke/archive.zip" async mcp-invoke
apply_pkg_zip_literal aura-memory-recall aura-nodejs-sync \
  "$ROOT/deploy/k8s/memory-recall/archive.zip" sync memory
apply_pkg_zip_literal aura-control-resolve aura-nodejs-sync \
  "$ROOT/deploy/k8s/control-resolve/archive.zip" sync control
apply_pkg_zip_literal aura-mcp-invoke-rpc aura-nodejs-sync \
  "$ROOT/deploy/k8s/mcp-invoke-rpc/archive.zip" sync mcp-invoke

echo "== prune legacy per-service Environments / *-rr / mcp RR ConfigMap =="
while read -r env; do
  [[ -z "$env" ]] && continue
  echo "delete $env"
  kubectl delete "$env" -n default --wait=false --ignore-not-found
done < <(kubectl get environment.fission.io -n default -o name 2>/dev/null \
  | grep -vE 'environment.fission.io/(aura-nodejs-async|aura-nodejs-sync)$' || true)
for dep in aura-memory-recall-rr aura-control-resolve-rr aura-mcp-invoke-rr; do
  kubectl -n default delete deploy/"$dep" --ignore-not-found --wait=false
done
# Legacy newdeploy Warm for sync Functions (now poolmgr) — do not delete poolmgr-* deploys.
while read -r nd; do
  [[ -z "$nd" ]] && continue
  echo "delete $nd"
  kubectl -n default delete "$nd" --wait=false --ignore-not-found
done < <(kubectl -n default get deploy -o name 2>/dev/null \
  | grep -E 'newdeploy-aura-(memory-recall|control-resolve|mcp-invoke-rpc)-' || true)
kubectl -n default delete configmap aura-mcp-invoke-rr-app --ignore-not-found
# Legacy: gateway/bridge lived in default — move to aura
kubectl -n default delete deploy/aura-gateway svc/aura-gateway \
  deploy/aura-nats-rpc-bridge configmap/aura-nats-rpc-bridge-app \
  --ignore-not-found --wait=false

echo "== wait always-on (ns aura) =="
kubectl -n aura rollout status deploy/aura-gateway --timeout=180s
kubectl -n aura rollout status deploy/aura-llm-gateway --timeout=180s
kubectl -n aura rollout status deploy/aura-nats-rpc-bridge --timeout=240s

echo
echo "apply-product: done (gateway+bridge in aura; Fission in default; smoke under deploy/dev not applied)."
