#!/bin/sh
# Runs inside nats-box. Env: NATS_URL SMOKE_ID
# V0.2: Core RR aura.rpc.smoke → rpc.smoke.done (Warm); no JetStream.
set -eu

RPC_SUBJ="aura.rpc.smoke"

[ -n "${NATS_URL:-}" ] || { echo FAIL_ENV; exit 1; }
[ -n "${SMOKE_ID:-}" ] || { echo FAIL_ENV; exit 1; }

PAYLOAD="{\"id\":\"${SMOKE_ID}\",\"type\":\"rpc.smoke\",\"payload\":{\"ping\":1}}"

echo "REQ $RPC_SUBJ $PAYLOAD"
OUT=$(nats req -s "$NATS_URL" "$RPC_SUBJ" "$PAYLOAD" --timeout=5s 2>&1) || {
  echo "FAIL_REQUEST"
  echo "$OUT"
  exit 2
}

echo "$OUT"
echo "$OUT" | grep -q "$SMOKE_ID" || { echo FAIL_ID; exit 3; }
echo "$OUT" | grep -q "rpc.smoke.done" || { echo FAIL_TYPE; exit 4; }
echo OK_RR
