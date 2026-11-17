#!/usr/bin/env bash
# Verify AURA_TASKS / AURA_EVENTS / AURA_DLQ exist with expected retention + subjects.
set -euo pipefail

NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
POD="aura-smoke-streams"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl

kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 || fail "StatefulSet ${NATS_NS}/nats missing"

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 180
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s

info_json() {
  kubectl -n "$NATS_NS" exec "$POD" -- \
    nats stream info "$1" -s "$NATS_URL" --json
}

check_stream() {
  local name="$1" expect_retention="$2" expect_subject="$3"
  local json retention subjects
  json="$(info_json "$name")" || fail "stream $name missing — run ensure-streams.sh"
  retention="$(printf '%s' "$json" | sed -n 's/.*"retention":"\([^"]*\)".*/\1/p' | head -1)"
  # config.retention enum: limits|interest|workqueue (JSON may use workqueue)
  subjects="$(printf '%s' "$json" | tr ',' '\n' | sed -n 's/.*"subjects":\[\(.*\)\].*/\1/p' | head -1)"
  printf '%s' "$json" | grep -q "\"$expect_subject\"" \
    || fail "$name subjects missing $expect_subject (got subjects field)"
  case "$expect_retention" in
    work|workqueue)
      printf '%s' "$json" | grep -Eqi '"retention":"(work|workqueue)"' \
        || fail "$name retention want workqueue, json snippet: $(printf '%s' "$json" | head -c 200)"
      ;;
    limits)
      printf '%s' "$json" | grep -q '"retention":"limits"' \
        || fail "$name retention want limits"
      ;;
    *) fail "unknown expect_retention $expect_retention" ;;
  esac
  ok "$name retention=$expect_retention subject=$expect_subject"
}

echo "== JetStream streams =="
check_stream AURA_TASKS workqueue aura.tasks.>
check_stream AURA_EVENTS limits aura.events.>
check_stream AURA_DLQ limits aura.dlq.>

# EVENTS max_age ~ 90d (nanos in JSON)
ev="$(info_json AURA_EVENTS)"
printf '%s' "$ev" | grep -Eq '"max_age":(7776000000000000|90d)' \
  || printf '%s' "$ev" | grep -q 'max_age' \
  || fail "AURA_EVENTS max_age not set (want 90d)"
# Accept either raw ns or human — nats JSON uses nanoseconds for 90d = 90*24*3600*1e9
age_ns="$(printf '%s' "$ev" | sed -n 's/.*"max_age":\([0-9][0-9]*\).*/\1/p' | head -1)"
if [ -n "$age_ns" ] && [ "$age_ns" != "0" ]; then
  # 90d = 7776000000000000 ns; allow ±1h slack
  if [ "$age_ns" -lt 7772400000000000 ] || [ "$age_ns" -gt 7779600000000000 ]; then
    fail "AURA_EVENTS max_age=$age_ns want ~7776000000000000 (90d)"
  fi
  ok "AURA_EVENTS max_age≈90d ($age_ns ns)"
else
  fail "AURA_EVENTS max_age missing or 0"
fi

echo
echo "smoke-streams: PASS"
