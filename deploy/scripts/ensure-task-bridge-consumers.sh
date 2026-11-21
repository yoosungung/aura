#!/usr/bin/env bash
# Ensure task-bridge JetStream pull consumers: AckWait ≥ fetch+margin, MaxDeliver finite.
# Idempotent. Matches services/nats-task-bridge DEFAULT_ACK_WAIT_MS (150s) / MaxDeliver=5.
set -euo pipefail

NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
STREAM="${STREAM:-AURA_TASKS}"
ACK_WAIT="${ACK_WAIT:-150s}"
MAX_DELIVER="${MAX_DELIVER:-5}"
POD="aura-ensure-task-bridge-consumers-$$"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl
fail() { echo "FAIL: $*" >&2; exit 1; }

kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || fail "StatefulSet ${NATS_NS}/nats missing — run install-runtime.sh first"
kubectl -n "$NATS_NS" rollout status sts/nats --timeout=120s >/dev/null

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 180
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s

nexec() { kubectl -n "$NATS_NS" exec "$POD" -- "$@"; }

ensure_one() {
  local durable="$1" filter="$2"
  if ! nexec nats consumer info "$STREAM" "$durable" -s "$NATS_URL" >/dev/null 2>&1; then
    echo "==> create ${STREAM}/${durable} filter=${filter} ack_wait=${ACK_WAIT}"
    nexec nats consumer add "$STREAM" "$durable" -s "$NATS_URL" \
      --pull \
      --filter="$filter" \
      --ack=explicit \
      --wait="$ACK_WAIT" \
      --deliver=all \
      --max-deliver="$MAX_DELIVER" \
      --max-pending=1000 \
      --defaults >/dev/null
  else
    echo "==> edit ${STREAM}/${durable} ack_wait=${ACK_WAIT} max_deliver=${MAX_DELIVER}"
    nexec nats consumer edit "$STREAM" "$durable" -s "$NATS_URL" \
      --wait="$ACK_WAIT" \
      --max-deliver="$MAX_DELIVER" \
      --force >/dev/null
  fi
  local info
  info=$(nexec nats consumer info "$STREAM" "$durable" -s "$NATS_URL")
  echo "$info" | grep -Eq "Ack Wait: *150(\.00)?s|Ack Wait: *2m30s" \
    || fail "${durable}: AckWait not ~150s after ensure (got: $(echo "$info" | grep -i 'Ack Wait' || true))"
  echo "$info" | grep -q "Maximum Deliveries: *${MAX_DELIVER}" \
    || fail "${durable}: MaxDeliver not ${MAX_DELIVER}"
  echo "OK: ${STREAM}/${durable} AckWait≈150s MaxDeliver=${MAX_DELIVER}"
}

ensure_one aura_task_bridge_agent aura.tasks.agent.invoke
ensure_one aura_task_bridge_mcp aura.tasks.mcp.invoke

echo
echo "ensure-task-bridge-consumers: done"
