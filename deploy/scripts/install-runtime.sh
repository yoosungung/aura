#!/usr/bin/env bash
# Install cluster runtime for Aura M0: NATS (Kustomize) + KEDA + Fission (Helm).
# Idempotent: kubectl apply + helm upgrade --install. Pins match Fission↔KEDA compat.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FISSION_VERSION="${FISSION_VERSION:-1.27.0}"
# Fission v1.27.0 is built against KEDA v2.20 (fission.io/docs/installation/compatibility)
KEDA_CHART_VERSION="${KEDA_CHART_VERSION:-2.20.2}"
KEDA_NS="${KEDA_NS:-keda}"
FISSION_NS="${FISSION_NS:-fission}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl
need helm

echo "== 1/3 NATS JetStream (deploy/k8s/base) =="
kubectl apply -k "$ROOT/deploy/k8s/base"
kubectl -n aura rollout status sts/nats --timeout=180s

echo "== 2/3 KEDA ${KEDA_CHART_VERSION} =="
helm repo add kedacore https://kedacore.github.io/charts 2>/dev/null || true
helm repo update kedacore
kubectl get ns "$KEDA_NS" >/dev/null 2>&1 || kubectl create namespace "$KEDA_NS"
helm upgrade --install keda kedacore/keda \
  --namespace "$KEDA_NS" \
  --version "$KEDA_CHART_VERSION" \
  --wait --timeout 5m

echo "== 3/3 Fission ${FISSION_VERSION} (mqt_keda.enabled=true) =="
helm repo add fission-charts https://fission.github.io/fission-charts/ 2>/dev/null || true
helm repo update fission-charts
kubectl get ns "$FISSION_NS" >/dev/null 2>&1 || kubectl create namespace "$FISSION_NS"
# CRDs before chart. Large OpenAPI schemas exceed last-applied annotation
# limit with client-side apply — use server-side (create still ok on empty cluster).
kubectl create -k "github.com/fission/fission/crds/v1?ref=v${FISSION_VERSION}" 2>/dev/null \
  || kubectl apply --server-side --force-conflicts \
       -k "github.com/fission/fission/crds/v1?ref=v${FISSION_VERSION}"

# internalAuth.enabled=false: stock KEDA connector images do not HMAC-sign
# router-internal calls (401). Signing-aware connectors = later; see SETUP.md.
helm upgrade --install fission fission-charts/fission-all \
  --namespace "$FISSION_NS" \
  --version "$FISSION_VERSION" \
  --set mqt_keda.enabled=true \
  --set internalAuth.enabled=false \
  --set prometheus.enabled=false \
  --set serviceType=ClusterIP \
  --set routerServiceType=ClusterIP \
  --wait --timeout 10m

echo "== streams AURA_TASKS / AURA_EVENTS / AURA_DLQ =="
bash "$ROOT/deploy/scripts/ensure-streams.sh"

echo
echo "install-runtime: done. Run:"
echo "  bash deploy/scripts/smoke-runtime.sh"
echo "  bash deploy/scripts/smoke-streams.sh"
