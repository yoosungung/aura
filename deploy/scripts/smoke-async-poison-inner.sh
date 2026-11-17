#!/bin/sh
# Runs inside nats-box. Env: NATS_URL POISON_ID MAX_DELIVER
# V0.3: deliberate fail + invalid JSON → errorTopic; consumer settles (no infinite retry).
set -eu

ERR_SUBJ="aura.events.tasks.smoke.error"
TASK_SUBJ="aura.tasks.smoke"
STREAM="${STREAM:-AURA_TASKS}"
CONSUMER="${CONSUMER:-aura_tasks_smoke}"
MAX_DELIVER="${MAX_DELIVER:-5}"

nats stream info AURA_TASKS -s "$NATS_URL" >/dev/null
nats stream info AURA_EVENTS -s "$NATS_URL" >/dev/null
nats consumer info "$STREAM" "$CONSUMER" -s "$NATS_URL" >/dev/null

cinfo=$(nats consumer info "$STREAM" "$CONSUMER" -s "$NATS_URL")
echo "$cinfo" | grep -q "Maximum Deliveries: *${MAX_DELIVER}" || {
  echo "FAIL_MAXDELIVER"
  exit 4
}
echo OK_MAXDELIVER

last_seq() {
  nats stream info AURA_EVENTS -s "$NATS_URL" \
    | sed -n 's/.*Last Sequence: *\([0-9][0-9]*\).*/\1/p' \
    | head -1
}

wait_msg() {
  subj="$1"
  needle="$2"
  after="$3"
  secs="$4"
  i=0
  while [ "$i" -lt "$secs" ]; do
    last=$(last_seq)
    if [ -n "$last" ] && [ "$last" -gt "$after" ]; then
      seq=$((after + 1))
      while [ "$seq" -le "$last" ]; do
        text=$(nats stream get AURA_EVENTS "$seq" -s "$NATS_URL" 2>/dev/null || true)
        echo "$text" | grep -q "$subj" || { seq=$((seq + 1)); continue; }
        if echo "$text" | grep -q "$needle"; then
          echo "$text"
          return 0
        fi
        seq=$((seq + 1))
      done
      after=$last
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

consumer_settled() {
  info=$(nats consumer info "$STREAM" "$CONSUMER" -s "$NATS_URL")
  echo "$info" | grep -q "Outstanding Acks: *0 " || return 1
  echo "$info" | grep -q "Redelivered Messages: *0" || return 1
  echo "$info" | grep -q "Unprocessed Messages: *0" || return 1
  return 0
}

BASE=$(last_seq)
echo "BASE_SEQ=$BASE"

FAIL_ID="${POISON_ID}-fail"
FAIL_PAYLOAD="{\"id\":\"${FAIL_ID}\",\"aura_smoke\":\"fail\"}"
nats pub -s "$NATS_URL" "$TASK_SUBJ" "$FAIL_PAYLOAD"
echo PUB_FAIL

wait_msg "$ERR_SUBJ" "$FAIL_ID" "$BASE" 120 || {
  echo FAIL_ERR_FAIL
  exit 2
}
echo OK_ERR_FAIL

BAD_BASE=$(last_seq)
BAD_MARK="${POISON_ID}-badjson"
nats pub -s "$NATS_URL" "$TASK_SUBJ" "{not-json-${BAD_MARK}"
echo PUB_BADJSON

wait_msg "$ERR_SUBJ" "$BAD_MARK" "$BAD_BASE" 120 || {
  echo FAIL_ERR_BADJSON
  exit 3
}
echo OK_ERR_BADJSON

# Isolation: after errorTopic publish the durable must not keep redriving poison.
i=0
while [ "$i" -lt 60 ]; do
  if consumer_settled; then
    echo OK_SETTLED
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo FAIL_SETTLED
exit 5
