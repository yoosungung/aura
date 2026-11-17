#!/usr/bin/env bash
# M0 bootstrap smoke: NATS JetStream + KEDA + Fission control plane.
# Exit 0 only when all three are Ready. No Function/MQT (later M0 tickets).
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

echo "== NATS (ns=aura) =="
kubectl -n aura get sts nats >/dev/null 2>&1 || fail "StatefulSet aura/nats missing"
kubectl -n aura rollout status sts/nats --timeout=120s || fail "nats not Ready"
kubectl -n aura exec sts/nats -- wget -qO- http://127.0.0.1:8222/healthz | grep -qi ok \
  || fail "nats /healthz"
# JetStream must be on (monitor varz /jsz)
kubectl -n aura exec sts/nats -- wget -qO- http://127.0.0.1:8222/jsz >/dev/null \
  || fail "nats /jsz (JetStream) unreachable"
ok "NATS JetStream Ready (client nats.aura:4222, monitor :8222)"

echo "== KEDA (ns=keda) =="
kubectl -n keda get deploy keda-operator >/dev/null 2>&1 || fail "keda-operator missing"
kubectl -n keda rollout status deploy/keda-operator --timeout=180s || fail "keda-operator not Ready"
kubectl -n keda rollout status deploy/keda-operator-metrics-apiserver --timeout=180s \
  || fail "keda metrics apiserver not Ready"
kubectl get crd scaledobjects.keda.sh >/dev/null 2>&1 || fail "ScaledObject CRD missing"
ok "KEDA Ready"

echo "== Fission (ns=fission) =="
kubectl -n fission get deploy >/dev/null 2>&1 || fail "fission namespace empty"
for d in router executor storagesvc; do
  kubectl -n fission get deploy "$d" >/dev/null 2>&1 || fail "fission deploy/$d missing"
  kubectl -n fission rollout status "deploy/$d" --timeout=300s || fail "fission $d not Ready"
done
kubectl -n fission get deploy mqtrigger-keda >/dev/null 2>&1 \
  || fail "deploy/mqtrigger-keda missing (install with mqt_keda.enabled=true)"
kubectl -n fission rollout status deploy/mqtrigger-keda --timeout=180s \
  || fail "mqtrigger-keda not Ready"
ok "Fission control plane Ready (mqtrigger-keda)"

echo
echo "smoke-runtime: PASS"
echo "  NATS:    nats://nats.aura.svc.cluster.local:4222  monitor :8222"
echo "  KEDA:    ns=keda"
echo "  Fission: ns=fission"
