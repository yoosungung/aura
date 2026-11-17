#!/usr/bin/env bash
# M0 live gate: MaxDeliver → AURA_DLQ via path ① (handler Term), not Advisory / not JS auto-move.
# Isolates from MQT aura_tasks_smoke / errorTopic (V0.3) — dedicated filter subject + consumer.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
MAX_DELIVER="${MAX_DELIVER:-3}"
POD="aura-smoke-dlq-term-$$"
INNER="$ROOT/deploy/scripts/smoke-dlq-term-inner.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl
[[ -f "$INNER" ]] || fail "missing $INNER"

kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || fail "StatefulSet ${NATS_NS}/nats missing"
kubectl -n "$NATS_NS" get pod -l app.kubernetes.io/name=nats --field-selector=status.phase=Running 2>/dev/null | grep -q nats \
  || kubectl -n "$NATS_NS" get pod nats-0 >/dev/null 2>&1 \
  || fail "nats pod not Ready"

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 600
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s
kubectl -n "$NATS_NS" cp "$INNER" "$POD:/tmp/smoke-dlq-term-inner.sh"

SMOKE_ID="dlqterm-$(date +%s)-$$"

RESULT=$(kubectl -n "$NATS_NS" exec "$POD" -- \
  env NATS_URL="$NATS_URL" MAX_DELIVER="$MAX_DELIVER" SMOKE_ID="$SMOKE_ID" \
  sh /tmp/smoke-dlq-term-inner.sh)

printf '%s\n' "$RESULT"
echo "$RESULT" | grep -q OK_MAXDELIVER || fail "MaxDeliver!=${MAX_DELIVER}"
echo "$RESULT" | grep -q OK_TERM || fail "Term on last delivery failed"
echo "$RESULT" | grep -q OK_DLQ_TERM || fail "AURA_DLQ missing smoke id"
ok "MaxDeliver=${MAX_DELIVER} → Term → AURA_DLQ for $SMOKE_ID"
ok "path=① handler Term (Advisory not used)"

echo
echo "smoke-dlq-term: PASS"
