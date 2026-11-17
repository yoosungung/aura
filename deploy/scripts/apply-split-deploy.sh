#!/usr/bin/env bash
# Apply V0.1 split-deploy skeletons: async-smoke + sync-smoke (ARCHITECTURE §4).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl

echo "== async-smoke (MQT minReplicaCount=0) =="
kubectl apply -k "$ROOT/deploy/k8s/async-smoke"

echo "== sync-smoke (newdeploy MinScale>=2, no MQT) =="
kubectl apply -k "$ROOT/deploy/k8s/sync-smoke"

echo "== wait sync Warm Pool =="
for i in $(seq 1 60); do
  DEP=$(kubectl -n default get deploy -o json 2>/dev/null | python3 -c '
import sys,json
for d in json.load(sys.stdin).get("items",[]):
  if "aura-rpc-smoke" in d["metadata"]["name"]:
    print(d["metadata"]["name"]); break
' || true)
  if [ -n "${DEP:-}" ]; then
    kubectl -n default rollout status "deploy/$DEP" --timeout=180s
    break
  fi
  sleep 2
done
[ -n "${DEP:-}" ] || { echo "FAIL: sync newdeploy for aura-rpc-smoke not found" >&2; exit 1; }

echo
echo "apply-split-deploy: done. Run: bash deploy/scripts/check-split-deploy.sh && bash deploy/scripts/smoke-split-deploy.sh"
