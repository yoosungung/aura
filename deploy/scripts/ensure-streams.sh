#!/usr/bin/env bash
# Ensure JetStream streams AURA_TASKS / AURA_EVENTS / AURA_DLQ (ARCHITECTURE §3.1–§3.2).
# Idempotent. Runs nats CLI inside a short-lived nats-box pod (ns aura).
# MaxDeliver→DLQ 택일 구현은 범위 밖 — 스트림 껍데기만 만든다.
set -euo pipefail

NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
POD="aura-ensure-streams"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl

kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || { echo "FAIL: StatefulSet ${NATS_NS}/nats missing — run install-runtime.sh first" >&2; exit 1; }
kubectl -n "$NATS_NS" rollout status sts/nats --timeout=120s

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 300
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s

nexec() { kubectl -n "$NATS_NS" exec "$POD" -- "$@"; }

ensure_stream() {
  local name="$1"
  shift
  if nexec nats stream info "$name" -s "$NATS_URL" >/dev/null 2>&1; then
    echo "OK: stream $name already exists"
    return 0
  fi
  echo "==> create stream $name"
  nexec nats stream add "$name" -s "$NATS_URL" --defaults "$@"
}

# WorkQueue — async MQT tasks (aura.tasks.>)
ensure_stream AURA_TASKS \
  --subjects='aura.tasks.>' \
  --retention=work \
  --storage=file \
  --replicas=1 \
  --discard=old \
  --description='Aura async WorkQueue (ARCHITECTURE §3.1)'

# Limits 90d — durable domain events (aura.events.>)
ensure_stream AURA_EVENTS \
  --subjects='aura.events.>' \
  --retention=limits \
  --storage=file \
  --replicas=1 \
  --discard=old \
  --max-age=90d \
  --description='Aura events Limits 90d (ARCHITECTURE §3.1)'

# Limits — poison / DLQ envelope target (aura.dlq.>) — path choice is later ticket
ensure_stream AURA_DLQ \
  --subjects='aura.dlq.>' \
  --retention=limits \
  --storage=file \
  --replicas=1 \
  --discard=old \
  --description='Aura DLQ Limits (ARCHITECTURE §3.2)'

echo
echo "ensure-streams: done. Run: bash deploy/scripts/smoke-streams.sh"
