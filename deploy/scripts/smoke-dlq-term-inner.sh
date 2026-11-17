#!/bin/sh
# Runs inside nats-box. Env: NATS_URL [MAX_DELIVER] [SMOKE_ID]
# Path ①: last delivery → publish AURA_DLQ → Term() (not JetStream auto-move; not Advisory).
set -eu

NATS_URL="${NATS_URL:?}"
MAX_DELIVER="${MAX_DELIVER:-3}"
SMOKE_ID="${SMOKE_ID:-dlqterm-$$}"
STREAM_TASKS="${STREAM_TASKS:-AURA_TASKS}"
STREAM_DLQ="${STREAM_DLQ:-AURA_DLQ}"
TASK_SUBJ="${TASK_SUBJ:-aura.tasks.dlq_term_smoke}"
DLQ_SUBJ="${DLQ_SUBJ:-aura.dlq.tasks.dlq_term_smoke}"
CONSUMER="${CONSUMER:-aura_dlq_term_smoke}"

nats stream info "$STREAM_TASKS" -s "$NATS_URL" >/dev/null
nats stream info "$STREAM_DLQ" -s "$NATS_URL" >/dev/null

nats consumer rm "$STREAM_TASKS" "$CONSUMER" -s "$NATS_URL" -f 2>/dev/null || true
nats consumer add "$STREAM_TASKS" "$CONSUMER" -s "$NATS_URL" \
  --pull --deliver=all --ack=explicit --max-deliver="$MAX_DELIVER" \
  --filter="$TASK_SUBJ" --wait=1s --defaults >/dev/null

cinfo=$(nats consumer info "$STREAM_TASKS" "$CONSUMER" -s "$NATS_URL")
echo "$cinfo" | grep -q "Maximum Deliveries: *${MAX_DELIVER}" || {
  echo FAIL_MAXDELIVER
  exit 4
}
echo OK_MAXDELIVER

last_seq() {
  nats stream info "$STREAM_DLQ" -s "$NATS_URL" \
    | sed -n 's/.*Last Sequence: *\([0-9][0-9]*\).*/\1/p' \
    | head -1
}

BASE=$(last_seq)
[ -n "$BASE" ] || BASE=0
echo "BASE_SEQ=$BASE"

PAYLOAD="{\"id\":\"${SMOKE_ID}\",\"path\":\"term\"}"
nats pub -s "$NATS_URL" "$TASK_SUBJ" "$PAYLOAD"
echo PUB_TASK

i=1
while [ "$i" -lt "$MAX_DELIVER" ]; do
  out=$(nats consumer next "$STREAM_TASKS" "$CONSUMER" -s "$NATS_URL" --nak --count=1)
  echo "$out" | grep -q "tries: ${i}" || {
    echo "FAIL_NAK_TRIES_${i}"
    exit 2
  }
  echo "OK_NAK_${i}"
  i=$((i + 1))
done

last=$(nats consumer next "$STREAM_TASKS" "$CONSUMER" -s "$NATS_URL" --term --count=1)
echo "$last" | grep -q "tries: ${MAX_DELIVER}" || {
  echo FAIL_TERM_TRIES
  exit 3
}
echo OK_TERM

DLQ_BODY="{\"id\":\"${SMOKE_ID}\",\"src\":\"${TASK_SUBJ}\",\"tries\":${MAX_DELIVER},\"path\":\"term\",\"echo\":${PAYLOAD}}"
nats pub -s "$NATS_URL" "$DLQ_SUBJ" "$DLQ_BODY"
echo PUB_DLQ

found=0
j=0
while [ "$j" -lt 30 ]; do
  cur=$(last_seq)
  [ -n "$cur" ] || cur=0
  if [ "$cur" -gt "$BASE" ]; then
    seq=$((BASE + 1))
    while [ "$seq" -le "$cur" ]; do
      text=$(nats stream get "$STREAM_DLQ" "$seq" -s "$NATS_URL" 2>/dev/null || true)
      if echo "$text" | grep -q "$DLQ_SUBJ" && echo "$text" | grep -q "$SMOKE_ID"; then
        found=1
        break
      fi
      seq=$((seq + 1))
    done
  fi
  [ "$found" -eq 1 ] && break
  j=$((j + 1))
  sleep 1
done

nats consumer rm "$STREAM_TASKS" "$CONSUMER" -s "$NATS_URL" -f >/dev/null 2>&1 || true

if [ "$found" -eq 1 ]; then
  echo "OK_DLQ_TERM id=${SMOKE_ID}"
  exit 0
fi
echo FAIL_DLQ
exit 5
