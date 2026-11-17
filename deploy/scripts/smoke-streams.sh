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
need python3

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
  local name="$1" expect_ret="$2" expect_subj="$3" expect_max_age_ns="${4:-}"
  local json
  json="$(info_json "$name")" || fail "stream $name missing — run ensure-streams.sh"
  NAME="$name" EXPECT_RET="$expect_ret" EXPECT_SUBJ="$expect_subj" EXPECT_AGE="$expect_max_age_ns" \
  JSON="$json" python3 - <<'PY' || fail "stream $name config mismatch"
import json, os, sys
name = os.environ["NAME"]
expect_ret = os.environ["EXPECT_RET"]
expect_subj = os.environ["EXPECT_SUBJ"]
expect_age = os.environ.get("EXPECT_AGE") or ""
cfg = json.loads(os.environ["JSON"]).get("config") or json.loads(os.environ["JSON"])
# nats CLI --json may nest under "config"
if "retention" not in cfg and "config" in cfg:
    cfg = cfg["config"]
ret = str(cfg.get("retention", "")).lower()
subs = cfg.get("subjects") or []
ok_ret = {
    "workqueue": ret in ("work", "workqueue"),
    "limits": ret == "limits",
}.get(expect_ret, ret == expect_ret)
if not ok_ret:
    print(f"retention want {expect_ret} got {ret}", file=sys.stderr)
    sys.exit(1)
if expect_subj not in subs:
    print(f"subjects want {expect_subj} got {subs}", file=sys.stderr)
    sys.exit(1)
if expect_age:
    want = int(expect_age)
    got = int(cfg.get("max_age") or 0)
    # ±1h slack
    if abs(got - want) > 3600_000_000_000:
        print(f"max_age want ~{want} got {got}", file=sys.stderr)
        sys.exit(1)
print(f"OK: {name} retention={ret} subjects={subs}" + (f" max_age={cfg.get('max_age')}" if expect_age else ""))
PY
}

echo "== JetStream streams =="
# 90d in nanoseconds
AGE_90D=$((90 * 24 * 3600 * 1000000000))
check_stream AURA_TASKS workqueue "aura.tasks.>"
check_stream AURA_EVENTS limits "aura.events.>" "$AGE_90D"
check_stream AURA_DLQ limits "aura.dlq.>"

echo
echo "smoke-streams: PASS"
