#!/usr/bin/env bash
# Ops CLI: list / inspect / replay AURA_DLQ (path ① Term). Live NATS optional.
# Default replay mode = dry-run. --confirm required to publish.
# Ticket 28cc3d9a · docs/dlq-replay.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPLAY_JS="$ROOT/services/ops/dlq-replay/replay.js"
NATS_URL="${NATS_URL:-nats://nats.nats.svc.cluster.local:4222}"
STREAM_DLQ="${STREAM_DLQ:-AURA_DLQ}"
MAX_BATCH="${MAX_BATCH:-20}"

usage() {
  cat <<'EOF'
Usage:
  dlq-replay.sh list
  dlq-replay.sh inspect --seq N
  dlq-replay.sh replay --dry-run [--seq N] [--id ID] [--src-prefix P] [--max-batch N]
  dlq-replay.sh replay --confirm [--seq N] [--id ID] [--src-prefix P] [--max-batch N]

Env: NATS_URL STREAM_DLQ MAX_BATCH
EOF
}

fail() { echo "FAIL: $*" >&2; exit 1; }
need_nats() {
  command -v nats >/dev/null 2>&1 || fail "nats CLI required for live ops"
  nats stream info "$STREAM_DLQ" -s "$NATS_URL" >/dev/null \
    || fail "stream $STREAM_DLQ unreachable at $NATS_URL"
}

CMD="${1:-}"
[[ -n "$CMD" ]] || { usage; exit 2; }
shift || true

SEQS=()
IDS=()
SRC_PREFIX=""
MODE=""
CONFIRM=0
DRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seq) SEQS+=("$2"); shift 2 ;;
    --id) IDS+=("$2"); shift 2 ;;
    --src-prefix) SRC_PREFIX="$2"; shift 2 ;;
    --max-batch) MAX_BATCH="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --confirm) CONFIRM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown arg: $1" ;;
  esac
done

stream_last_seq() {
  nats stream info "$STREAM_DLQ" -s "$NATS_URL" --json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"]["last_seq"])' \
    || nats stream info "$STREAM_DLQ" -s "$NATS_URL" \
      | sed -n 's/.*Last Sequence: *\([0-9][0-9]*\).*/\1/p' | head -1
}

stream_first_seq() {
  nats stream info "$STREAM_DLQ" -s "$NATS_URL" --json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"]["first_seq"])' \
    || nats stream info "$STREAM_DLQ" -s "$NATS_URL" \
      | sed -n 's/.*First Sequence: *\([0-9][0-9]*\).*/\1/p' | head -1
}

get_msg_json() {
  local seq="$1"
  nats stream get "$STREAM_DLQ" "$seq" -s "$NATS_URL" --json
}

case "$CMD" in
  list)
    need_nats
    first=$(stream_first_seq)
    last=$(stream_last_seq)
    echo "stream=$STREAM_DLQ first_seq=$first last_seq=$last"
    if [[ -z "$last" || "$last" == "0" ]]; then
      echo "empty"
      exit 0
    fi
    first=${first:-1}
    # Cap listing window to max_batch from the end
    start=$first
    if [[ $((last - first + 1)) -gt $MAX_BATCH ]]; then
      start=$((last - MAX_BATCH + 1))
    fi
    seq=$start
    while [[ "$seq" -le "$last" ]]; do
      raw=$(get_msg_json "$seq" 2>/dev/null || true)
      if [[ -n "$raw" ]]; then
        echo "$raw" | python3 -c '
import json, sys, base64
m = json.load(sys.stdin)
subj = m.get("subject") or m.get("Subject") or "?"
data = m.get("data") or ""
obj = {}
try:
    body = base64.b64decode(data).decode("utf-8", "replace") if data else ""
    obj = json.loads(body) if body else {}
except Exception:
    pass
seq = m.get("seq", m.get("sequence", "?"))
print("seq=%s subject=%s id=%s src=%s" % (seq, subj, obj.get("id", ""), obj.get("src", "")))
' 2>/dev/null || echo "seq=$seq (unparsed)"
      fi
      seq=$((seq + 1))
    done
    ;;

  inspect)
    need_nats
    [[ ${#SEQS[@]} -eq 1 ]] || fail "inspect requires exactly one --seq"
    get_msg_json "${SEQS[0]}"
    ;;

  replay)
    need_nats
    [[ -f "$REPLAY_JS" ]] || fail "missing $REPLAY_JS"
    if [[ "$CONFIRM" -eq 1 ]]; then
      MODE=confirm
    else
      MODE=dry_run
      DRY=1
    fi
    if [[ "$CONFIRM" -eq 1 && "$DRY" -eq 1 ]]; then
      fail "use either --dry-run or --confirm, not both"
    fi

    # Collect records: explicit seqs or recent window
    RECORDS_JSON=$(
      python3 - "$STREAM_DLQ" "$NATS_URL" "$MAX_BATCH" "${SEQS[@]:-}" <<'PY'
import json, os, subprocess, sys, base64

stream, url, max_batch = sys.argv[1], sys.argv[2], int(sys.argv[3])
seqs = [int(x) for x in sys.argv[4:] if x]

def run(args):
    return subprocess.check_output(args, text=True)

if not seqs:
    info = json.loads(run(["nats", "stream", "info", stream, "-s", url, "--json"]))
    last = int(info["state"]["last_seq"])
    first = int(info["state"]["first_seq"])
    if last == 0:
        print("[]")
        raise SystemExit(0)
    start = max(first, last - max_batch + 1)
    seqs = list(range(start, last + 1))

records = []
for seq in seqs:
    try:
        raw = run(["nats", "stream", "get", stream, str(seq), "-s", url, "--json"])
        m = json.loads(raw)
    except Exception:
        continue
    data = m.get("data") or ""
    body = ""
    if data:
        try:
            body = base64.b64decode(data).decode("utf-8")
            parsed = json.loads(body)
        except Exception:
            parsed = body
    else:
        parsed = {}
    records.append({
        "seq": int(m.get("seq") or m.get("sequence") or seq),
        "subject": m.get("subject") or m.get("Subject"),
        "data": parsed,
    })
print(json.dumps(records))
PY
    )

    PLAN=$(
      RECORDS_JSON="$RECORDS_JSON" MODE="$MODE" MAX_BATCH="$MAX_BATCH" \
      SRC_PREFIX="$SRC_PREFIX" IDS="$(IFS=,; echo "${IDS[*]:-}")" SEQS="$(IFS=,; echo "${SEQS[*]:-}")" \
      node -e '
const { planReplay } = require(process.argv[1]);
const records = JSON.parse(process.env.RECORDS_JSON || "[]");
const ids = (process.env.IDS || "").split(",").filter(Boolean);
const seqs = (process.env.SEQS || "").split(",").filter(Boolean).map(Number);
const plan = planReplay({
  records,
  mode: process.env.MODE,
  max_batch: Number(process.env.MAX_BATCH || 20),
  ids: ids.length ? ids : undefined,
  seqs: seqs.length ? seqs : undefined,
  src_prefix: process.env.SRC_PREFIX || undefined,
});
process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
' "$REPLAY_JS"
    )
    echo "$PLAN"

    if [[ "$MODE" != "confirm" ]]; then
      echo "dry-run only — re-run with --confirm to publish"
      exit 0
    fi

    echo "$PLAN" | node -e '
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(0, "utf8"));
if (!plan.execute) process.exit(0);
for (const p of plan.publishes) {
  const row = JSON.stringify({ subject: p.subject, data: p.data, headers: p.headers || {} });
  process.stdout.write(row + "\n");
}
' | while IFS= read -r row; do
      subj=$(echo "$row" | python3 -c 'import json,sys; print(json.load(sys.stdin)["subject"])')
      data=$(echo "$row" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"])')
      echo "PUB $subj"
      nats pub -s "$NATS_URL" "$subj" "$data"
    done
    echo "replay confirm: done"
    ;;

  *)
    usage
    fail "unknown command: $CMD"
    ;;
esac
