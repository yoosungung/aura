#!/usr/bin/env bash
# Apply product workloads (not deploy/dev smoke). Requires install-runtime + install-pg-pooler.
# Packages with invalid nested archive schema are applied as deployment.literal from archive.zip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl
need python3

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

echo "== product kustomize (literal packages) =="
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

echo "== agent/mcp env+function+mqt (packages via zip literal) =="
kubectl apply -f "$ROOT/deploy/k8s/agent-invoke/environment.yaml" \
  -f "$ROOT/deploy/k8s/agent-invoke/function.yaml" \
  -f "$ROOT/deploy/k8s/agent-invoke/mqt.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke/environment.yaml" \
  -f "$ROOT/deploy/k8s/mcp-invoke/function.yaml" \
  -f "$ROOT/deploy/k8s/mcp-invoke/mqt.yaml"
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke-rpc/environment.yaml" \
  -f "$ROOT/deploy/k8s/mcp-invoke-rpc/function.yaml"

apply_pkg_zip_literal aura-agent-invoke aura-agent-invoke-nodejs \
  "$ROOT/deploy/k8s/agent-invoke/archive.zip" async agent-invoke
apply_pkg_zip_literal aura-mcp-invoke aura-mcp-invoke-nodejs \
  "$ROOT/deploy/k8s/mcp-invoke/archive.zip" async mcp-invoke
apply_pkg_zip_literal aura-mcp-invoke-rpc aura-mcp-invoke-rpc-nodejs \
  "$ROOT/deploy/k8s/mcp-invoke-rpc/archive.zip" sync mcp-invoke

echo "== mcp RR ConfigMap from archive + Deployment =="
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
unzip -qo "$ROOT/deploy/k8s/mcp-invoke-rpc/archive.zip" -d "$STAGE"
kubectl -n default create configmap aura-mcp-invoke-rr-app \
  --from-file="$STAGE" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$ROOT/deploy/k8s/mcp-invoke-rpc/rpc-responder.yaml"

echo "== wait always-on =="
kubectl -n default rollout status deploy/aura-gateway --timeout=180s
kubectl -n aura rollout status deploy/aura-llm-gateway --timeout=180s
for dep in aura-memory-recall-rr aura-control-resolve-rr aura-mcp-invoke-rr; do
  kubectl -n default rollout status "deploy/$dep" --timeout=240s
done

echo
echo "apply-product: done (smoke under deploy/dev not applied)."
