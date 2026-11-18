#!/usr/bin/env bash
# Install CloudNativePG operator + aura-pg Cluster + transaction Pooler.
# Pins: chart cloudnative-pg 0.29.2 (app 1.30.2). Idempotent helm upgrade --install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CNPG_CHART_VERSION="${CNPG_CHART_VERSION:-0.29.2}"
CNPG_NS="${CNPG_NS:-cnpg-system}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl
need helm

echo "== 0/2 static gate =="
bash "$ROOT/deploy/scripts/check-pg-pooler.sh"

echo "== 1/2 CloudNativePG operator ${CNPG_CHART_VERSION} =="
helm repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
helm repo update cnpg
kubectl get ns "$CNPG_NS" >/dev/null 2>&1 || kubectl create namespace "$CNPG_NS"
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace "$CNPG_NS" \
  --version "$CNPG_CHART_VERSION" \
  --wait --timeout 5m

echo "== 2/2 Cluster aura-pg + Pooler aura-pg-pooler (deploy/k8s/pg-pooler) =="
kubectl get ns aura >/dev/null 2>&1 || kubectl create namespace aura
kubectl apply -k "$ROOT/deploy/k8s/pg-pooler"
kubectl -n aura wait --for=condition=Ready cluster/aura-pg --timeout=300s
kubectl -n aura rollout status deployment/aura-pg-pooler --timeout=180s

echo
echo "install-pg-pooler: done."
echo "  App DSN host (only): aura-pg-pooler.aura.svc.cluster.local:5432"
echo "  Password Secret:     aura-pg-app (key password)"
echo "  ConfigMap:           aura-pg-dsn"
echo "  Next (V1.1 / ticket 92cccf21): bash deploy/scripts/smoke-pg-pooler.sh"
