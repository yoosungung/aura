#!/usr/bin/env bash
# Apply V0.1 split-deploy smoke harness (dev/test only — not production).
# Manifests: deploy/dev/k8s/{async,sync}-smoke (ARCHITECTURE §4 sample).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl

echo "== async-smoke (MQT minReplicaCount=0) =="
kubectl apply -k "$ROOT/deploy/dev/k8s/async-smoke"

echo "== sync-smoke (newdeploy MinScale>=2, no MQT) =="
kubectl apply -k "$ROOT/deploy/dev/k8s/sync-smoke"

echo "== async consumer MaxDeliver (ARCHITECTURE §3.2) =="
# Best-effort: consumer appears after MQT first interest; poison smoke re-ensures.
bash "$ROOT/deploy/scripts/ensure-async-consumer.sh" || \
  echo "WARN: ensure-async-consumer deferred — run smoke-async-poison.sh (re-ensures)"

echo "== wait sync Warm Pool (Fission newdeploy) =="
for i in $(seq 1 60); do
  DEP=$(kubectl -n default get deploy -o json 2>/dev/null | python3 -c '
import sys,json
for d in json.load(sys.stdin).get("items",[]):
  n=d["metadata"]["name"]
  if n.startswith("newdeploy-aura-rpc-smoke") or n=="aura-rpc-smoke":
    print(n); break
' || true)
  if [ -n "${DEP:-}" ]; then
    kubectl -n default rollout status "deploy/$DEP" --timeout=180s
    break
  fi
  sleep 2
done
[ -n "${DEP:-}" ] || { echo "FAIL: sync newdeploy for aura-rpc-smoke not found" >&2; exit 1; }

echo "== wait sync Core RR responder =="
kubectl -n default rollout status deploy/aura-rpc-smoke-rr --timeout=180s

echo
echo "apply-split-deploy: done. Run: bash deploy/scripts/check-split-deploy.sh && bash deploy/scripts/smoke-split-deploy.sh && bash deploy/scripts/smoke-sync-rpc.sh"
