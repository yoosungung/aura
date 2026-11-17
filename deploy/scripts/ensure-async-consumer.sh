#!/usr/bin/env bash
# Ensure durable pull consumer aura_tasks_smoke has finite MaxDeliver (ARCHITECTURE §3.2 draft=5).
# MQT may create the consumer first; we edit MaxDeliver afterward (idempotent).
# AURA_DLQ Term/Advisory path is out of scope — errorTopic isolation is V0.3 evidence.
set -euo pipefail

NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
STREAM="${STREAM:-AURA_TASKS}"
CONSUMER="${CONSUMER:-aura_tasks_smoke}"
MAX_DELIVER="${MAX_DELIVER:-5}"
POD="aura-ensure-async-consumer-$$"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl

fail() { echo "FAIL: $*" >&2; exit 1; }

kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || fail "StatefulSet ${NATS_NS}/nats missing"
kubectl get messagequeuetrigger.fission.io aura-tasks-smoke -n default >/dev/null 2>&1 \
  || fail "MQT aura-tasks-smoke missing — run apply-split-deploy.sh first"

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 120
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s

nexec() { kubectl -n "$NATS_NS" exec "$POD" -- "$@"; }

# Wait until MQT has created the durable (first scale-up may be idle).
ready=0
for _ in $(seq 1 60); do
  if nexec nats consumer info "$STREAM" "$CONSUMER" -s "$NATS_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" -eq 1 ]] || fail "consumer ${STREAM}/${CONSUMER} not found after wait"

info=$(nexec nats consumer info "$STREAM" "$CONSUMER" -s "$NATS_URL")
if echo "$info" | grep -q "Maximum Deliveries: *${MAX_DELIVER}"; then
  echo "OK: ${STREAM}/${CONSUMER} MaxDeliver=${MAX_DELIVER}"
else
  echo "==> set MaxDeliver=${MAX_DELIVER} on ${STREAM}/${CONSUMER}"
  nexec nats consumer edit "$STREAM" "$CONSUMER" -s "$NATS_URL" \
    --max-deliver="$MAX_DELIVER" --force
  info=$(nexec nats consumer info "$STREAM" "$CONSUMER" -s "$NATS_URL")
  echo "$info" | grep -q "Maximum Deliveries: *${MAX_DELIVER}" \
    || fail "MaxDeliver not ${MAX_DELIVER} after edit"
  echo "OK: MaxDeliver=${MAX_DELIVER}"
fi

echo
echo "ensure-async-consumer: done"
