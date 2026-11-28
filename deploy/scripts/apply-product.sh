#!/usr/bin/env bash
# Apply product workloads (not deploy/dev smoke). Requires install-runtime + install-pg-pooler.
# Shared Fission Environments: agent/mcp only (async/sync poolmgr).
# Sync: rpc-bridge → Deployment Service (recall/resolve) or Fission (mcp.tool).
# Memory/compliance async: JetStream Deployments (no Fission MQT).
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

echo "== build agent/mcp archives + hardcoded memory images =="
bash "$ROOT/deploy/scripts/build-agent-invoke-archive.sh"
bash "$ROOT/deploy/scripts/build-mcp-invoke-archive.sh"
bash "$ROOT/deploy/scripts/build-agent-invoke-python-archive.sh"
bash "$ROOT/deploy/scripts/build-mcp-invoke-python-archive.sh"
bash "$ROOT/deploy/scripts/build-hardcoded-memory-images.sh" \
  || echo "WARN: docker build hardcoded images deferred (need docker)"

echo "== shared runtime Environments (nodejs + python) =="
kubectl apply -k "$ROOT/deploy/k8s/runtime-envs"

echo "== task-bridge JetStream consumers (AckWait≥150s) =="
bash "$ROOT/deploy/scripts/ensure-task-bridge-consumers.sh" \
  || echo "WARN: ensure-task-bridge-consumers deferred — bridge jsm ensure on start"

echo "== nats-rpc-bridge + nats-task-bridge (ns aura; baked images) =="
# Images: bash deploy/scripts/build-nats-bridge-images.sh (load into cluster as needed).
kubectl apply -k "$ROOT/deploy/k8s/nats-rpc-bridge"
kubectl apply -k "$ROOT/deploy/k8s/nats-task-bridge"
# Legacy ConfigMap mount retired (M3.6).
kubectl -n aura delete configmap aura-nats-rpc-bridge-app --ignore-not-found

echo "== product kustomize =="
PRODUCT=(
  gateway
  llm-gateway
  memory-capture
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

echo "== prune retired store/embed + batch always-on Deployments (CronJob-only batch) =="
kubectl -n aura delete deploy/aura-memory-store deploy/aura-memory-embed \
  deploy/aura-memory-ttl deploy/aura-memory-consolidate \
  deploy/aura-memory-archive deploy/aura-memory-object-gc \
  --ignore-not-found --wait=false

echo "== rustfs (aura-content) =="
kubectl apply -k "$ROOT/deploy/k8s/rustfs"

echo "== control-admin + admin-ui (Pooler DDL + SPA) =="
bash "$ROOT/deploy/scripts/apply-admin-ui.sh"

echo "== agent/mcp functions (task-bridge; no language MQT) =="
# Retire legacy agent/mcp MessageQueueTriggers (M3.6 multi-runtime).
kubectl -n default delete messagequeuetrigger.fission.io/aura-agent-invoke \
  messagequeuetrigger.fission.io/aura-mcp-invoke --ignore-not-found --wait=false 2>/dev/null || true
kubectl apply -f "$ROOT/deploy/k8s/agent-invoke/function.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke/function.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke-rpc/function.yaml"
kubectl apply -f "$ROOT/deploy/k8s/agent-invoke-py/function.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke-py/function.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke-rpc-py/function.yaml"

apply_pkg_zip_literal aura-agent-invoke aura-nodejs-async \
  "$ROOT/deploy/k8s/agent-invoke/archive.zip" async agent-invoke
apply_pkg_zip_literal aura-mcp-invoke aura-nodejs-async \
  "$ROOT/deploy/k8s/mcp-invoke/archive.zip" async mcp-invoke
apply_pkg_zip_literal aura-mcp-invoke-rpc aura-nodejs-sync \
  "$ROOT/deploy/k8s/mcp-invoke-rpc/archive.zip" sync mcp-invoke
apply_pkg_zip_literal aura-agent-invoke-py aura-python-async \
  "$ROOT/deploy/k8s/agent-invoke-py/archive.zip" async agent-invoke
apply_pkg_zip_literal aura-mcp-invoke-py aura-python-async \
  "$ROOT/deploy/k8s/mcp-invoke-py/archive.zip" async mcp-invoke
apply_pkg_zip_literal aura-mcp-invoke-rpc-py aura-python-sync \
  "$ROOT/deploy/k8s/mcp-invoke-rpc-py/archive.zip" sync mcp-invoke

echo "== prune retired memory/control/compliance Fission CRDs =="
for fn in aura-memory-store aura-memory-capture aura-memory-embed aura-memory-recall \
  aura-memory-consolidate aura-memory-ttl aura-memory-archive aura-memory-object-gc \
  aura-control-resolve aura-compliance-erase; do
  kubectl -n default delete function.fission.io/"$fn" package.fission.io/"$fn" \
    messagequeuetrigger.fission.io/"$fn" --ignore-not-found --wait=false 2>/dev/null || true
done

echo "== prune legacy per-service Environments / *-rr / mcp RR ConfigMap =="
while read -r env; do
  [[ -z "$env" ]] && continue
  echo "delete $env"
  kubectl delete "$env" -n default --wait=false --ignore-not-found
done < <(kubectl get environment.fission.io -n default -o name 2>/dev/null \
  | grep -vE 'environment.fission.io/(aura-nodejs-async|aura-nodejs-sync|aura-python-async|aura-python-sync)$' || true)
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
