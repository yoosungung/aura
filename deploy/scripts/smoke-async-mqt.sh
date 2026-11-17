#!/usr/bin/env bash
# Live MQT gate: aura.tasks.smoke → echo → respTopic / errorTopic (SETUP naming).
# Requires: streams + async-smoke + Fission internalAuth.enabled=false.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
POD="aura-smoke-async-mqt-$$"
INNER="$ROOT/deploy/scripts/smoke-async-mqt-inner.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl
[[ -f "$INNER" ]] || fail "missing $INNER"

kubectl get messagequeuetrigger.fission.io aura-tasks-smoke -n default >/dev/null 2>&1 \
  || fail "MQT aura-tasks-smoke missing — run apply-split-deploy.sh"
kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || fail "StatefulSet ${NATS_NS}/nats missing"

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 600
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s
kubectl -n "$NATS_NS" cp "$INNER" "$POD:/tmp/smoke-async-mqt-inner.sh"

SMOKE_ID="smoke-$(date +%s)-$$"
FAIL_ID="${SMOKE_ID}-fail"

RESULT=$(kubectl -n "$NATS_NS" exec "$POD" -- \
  env NATS_URL="$NATS_URL" SMOKE_ID="$SMOKE_ID" FAIL_ID="$FAIL_ID" \
  sh /tmp/smoke-async-mqt-inner.sh)

printf '%s\n' "$RESULT"
echo "$RESULT" | grep -q OK_DONE || fail "respTopic missing for id=$SMOKE_ID"
echo "$RESULT" | grep -q OK_ERR || fail "errorTopic missing for id=$FAIL_ID"
ok "respTopic echo for $SMOKE_ID"
ok "errorTopic for $FAIL_ID"

echo
echo "smoke-async-mqt: PASS"
