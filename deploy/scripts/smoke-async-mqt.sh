#!/usr/bin/env bash
# Live MQT gate: aura.tasks.smoke → echo → respTopic / errorTopic (SETUP naming).
# Requires cluster with streams + async-smoke applied. Uses nats-box in ns aura.
set -euo pipefail

NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
POD="aura-smoke-async-mqt"
DONE_SUBJ="aura.events.tasks.smoke.done"
ERR_SUBJ="aura.events.tasks.smoke.error"
TASK_SUBJ="aura.tasks.smoke"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl
need python3

kubectl get messagequeuetrigger.fission.io aura-tasks-smoke -n default >/dev/null 2>&1 \
  || fail "MQT aura-tasks-smoke missing — run apply-split-deploy.sh"
kubectl -n "$NATS_NS" get sts nats >/dev/null 2>&1 \
  || fail "StatefulSet ${NATS_NS}/nats missing"

cleanup() { kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
cleanup
for _ in $(seq 1 30); do
  kubectl -n "$NATS_NS" get pod "$POD" >/dev/null 2>&1 || break
  sleep 1
done
trap cleanup EXIT

kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
  --command -- sleep 600
kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=90s

nexec() { kubectl -n "$NATS_NS" exec "$POD" -- "$@"; }

nexec nats stream info AURA_TASKS -s "$NATS_URL" >/dev/null \
  || fail "stream AURA_TASKS missing — run ensure-streams.sh"
nexec nats stream info AURA_EVENTS -s "$NATS_URL" >/dev/null \
  || fail "stream AURA_EVENTS missing — run ensure-streams.sh"

events_last_seq() {
  nexec nats stream info AURA_EVENTS -s "$NATS_URL" --json \
    | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["state"]["last_seq"]))'
}

# Print first matching stream message text (subject + needle) after after_seq; else fail.
wait_event() {
  local subject="$1" needle="$2" after_seq="$3" seconds="$4"
  local i last seq text
  for i in $(seq 1 "$seconds"); do
    last=$(events_last_seq)
    if [[ "$last" -gt "$after_seq" ]]; then
      for seq in $(seq $((after_seq + 1)) "$last"); do
        text=$(nexec nats stream get AURA_EVENTS "$seq" -s "$NATS_URL" 2>/dev/null || true)
        # nats CLI: "... on Subject aura.events.tasks.smoke.done"
        if printf '%s' "$text" | grep -q "Subject ${subject}" \
          && printf '%s' "$text" | grep -q "$needle"; then
          printf '%s\n' "$text"
          return 0
        fi
      done
      after_seq=$last
    fi
    sleep 1
  done
  return 1
}

SMOKE_ID="smoke-$(date +%s)-$$"
DONE_PAYLOAD=$(python3 -c "import json; print(json.dumps({'id':'$SMOKE_ID','type':'tasks.smoke','payload':{'ping':1}}))")
FAIL_ID="${SMOKE_ID}-fail"
FAIL_PAYLOAD=$(python3 -c "import json; print(json.dumps({'id':'$FAIL_ID','aura_smoke':'fail'}))")

BASE_SEQ=$(events_last_seq)
echo "== pub success → $TASK_SUBJ (id=$SMOKE_ID) base_seq=$BASE_SEQ =="
nexec nats pub -s "$NATS_URL" "$TASK_SUBJ" "$DONE_PAYLOAD"

echo "== wait respTopic $DONE_SUBJ =="
DONE_OUT=$(wait_event "$DONE_SUBJ" "$SMOKE_ID" "$BASE_SEQ" 90) \
  || fail "no done envelope with id=$SMOKE_ID within 90s (check internalAuth.enabled=false + connector logs)"
printf '%s\n' "$DONE_OUT" | grep -q "tasks.smoke.done" \
  || fail "done payload missing type tasks.smoke.done"
ok "respTopic received echo for $SMOKE_ID"

ERR_BASE=$(events_last_seq)
echo "== pub fail → $TASK_SUBJ (id=$FAIL_ID) base_seq=$ERR_BASE =="
nexec nats pub -s "$NATS_URL" "$TASK_SUBJ" "$FAIL_PAYLOAD"

echo "== wait errorTopic $ERR_SUBJ (after MQT retries) =="
ERR_OUT=""
if ERR_OUT=$(wait_event "$ERR_SUBJ" "$FAIL_ID" "$ERR_BASE" 120); then
  :
elif ERR_OUT=$(wait_event "$ERR_SUBJ" "aura_smoke_fail" "$ERR_BASE" 30); then
  :
else
  fail "no errorTopic message for id=$FAIL_ID within ~150s"
fi
ok "errorTopic observed for fail path"
printf '%s\n' "$ERR_OUT" | head -c 400; echo

echo
echo "smoke-async-mqt: PASS"
