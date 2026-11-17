#!/usr/bin/env bash
# V0.3 live gate: poison (fail + invalid JSON) → errorTopic; MaxDeliver finite; no infinite retry.
# AURA_DLQ path is ① Term (smoke-dlq-term.sh) — this slice accepts errortopic residual only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
MAX_DELIVER="${MAX_DELIVER:-5}"
POD="aura-smoke-async-poison-$$"
INNER="$ROOT/deploy/scripts/smoke-async-poison-inner.sh"
ENSURE="$ROOT/deploy/scripts/ensure-async-consumer.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl
[[ -f "$INNER" ]] || fail "missing $INNER"
[[ -x "$ENSURE" || -f "$ENSURE" ]] || fail "missing $ENSURE"

kubectl get messagequeuetrigger.fission.io aura-tasks-smoke -n default >/dev/null 2>&1 \
  || fail "MQT aura-tasks-smoke missing — run apply-split-deploy.sh"
kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || fail "StatefulSet ${NATS_NS}/nats missing"

# Finite MaxDeliver before poison publish (ARCHITECTURE §3.2).
MAX_DELIVER="$MAX_DELIVER" bash "$ENSURE"

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 600
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s
kubectl -n "$NATS_NS" cp "$INNER" "$POD:/tmp/smoke-async-poison-inner.sh"

POISON_ID="poison-$(date +%s)-$$"

RESULT=$(kubectl -n "$NATS_NS" exec "$POD" -- \
  env NATS_URL="$NATS_URL" POISON_ID="$POISON_ID" MAX_DELIVER="$MAX_DELIVER" \
  sh /tmp/smoke-async-poison-inner.sh)

printf '%s\n' "$RESULT"
echo "$RESULT" | grep -q OK_MAXDELIVER || fail "MaxDeliver!=${MAX_DELIVER}"
echo "$RESULT" | grep -q OK_ERR_FAIL || fail "errorTopic missing for fail id"
echo "$RESULT" | grep -q OK_ERR_BADJSON || fail "errorTopic missing for invalid JSON"
echo "$RESULT" | grep -q OK_SETTLED || fail "consumer did not settle (infinite retry?)"
ok "MaxDeliver=${MAX_DELIVER}"
ok "errorTopic fail + invalid JSON for $POISON_ID"
ok "consumer settled (acks/redelivered/unprocessed=0)"

echo
echo "smoke-async-poison: PASS"
