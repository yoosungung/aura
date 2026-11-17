#!/bin/sh
# Runs inside nats-box. Env: NATS_URL SMOKE_ID FAIL_ID
set -eu

DONE_SUBJ="aura.events.tasks.smoke.done"
ERR_SUBJ="aura.events.tasks.smoke.error"
TASK_SUBJ="aura.tasks.smoke"

nats stream info AURA_TASKS -s "$NATS_URL" >/dev/null
nats stream info AURA_EVENTS -s "$NATS_URL" >/dev/null

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
        # nats CLI: "... on Subject aura.events...."
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

BASE=$(last_seq)
echo "BASE_SEQ=$BASE"
DONE_PAYLOAD="{\"id\":\"${SMOKE_ID}\",\"type\":\"tasks.smoke\",\"payload\":{\"ping\":1}}"
nats pub -s "$NATS_URL" "$TASK_SUBJ" "$DONE_PAYLOAD"
echo PUB_DONE

wait_msg "$DONE_SUBJ" "$SMOKE_ID" "$BASE" 90 || { echo FAIL_DONE; exit 2; }
echo OK_DONE

ERR_BASE=$(last_seq)
FAIL_PAYLOAD="{\"id\":\"${FAIL_ID}\",\"aura_smoke\":\"fail\"}"
nats pub -s "$NATS_URL" "$TASK_SUBJ" "$FAIL_PAYLOAD"
echo PUB_FAIL

if wait_msg "$ERR_SUBJ" "$FAIL_ID" "$ERR_BASE" 120; then
  :
elif wait_msg "$ERR_SUBJ" "aura_smoke_fail" "$ERR_BASE" 30; then
  :
else
  echo FAIL_ERR
  exit 3
fi
echo OK_ERR
