#!/usr/bin/env bash
# V0.2 live gate: aura.rpc.smoke Core RR — Warm success + scale-0 No Responders.
# Requires: apply-split-deploy (aura-rpc-smoke-rr replicas>=2). No MQT/lag.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NATS_NS="${NATS_NS:-aura}"
NATS_URL="${NATS_URL:-nats://nats.${NATS_NS}.svc.cluster.local:4222}"
NATS_BOX_IMAGE="${NATS_BOX_IMAGE:-natsio/nats-box:0.19.0}"
RR_DEPLOY="${RR_DEPLOY:-aura-rpc-smoke-rr}"
RR_NS="${RR_NS:-default}"
POD=""
INNER="$ROOT/deploy/scripts/smoke-sync-rpc-inner.sh"
SMOKE_ID="sync-$(date +%s)-$$"
POD_SEQ=0

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl
need python3
[[ -f "$INNER" ]] || fail "missing $INNER"

cleanup() {
  if [[ -n "${POD:-}" ]]; then
    kubectl -n "$NATS_NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

new_probe_pod() {
  cleanup
  POD_SEQ=$((POD_SEQ + 1))
  POD="aura-smoke-sync-rpc-$$-${POD_SEQ}"
  # wait until previous name is gone if any race
  kubectl -n "$NATS_NS" wait --for=delete "pod/$POD" --timeout=5s >/dev/null 2>&1 || true
  kubectl -n "$NATS_NS" run "$POD" --restart=Never --image="$NATS_BOX_IMAGE" \
    --command -- sleep 3600 >/dev/null
  kubectl -n "$NATS_NS" wait --for=condition=Ready "pod/$POD" --timeout=60s >/dev/null
}

echo "== ensure RR deploy Warm =="
kubectl -n "$RR_NS" get deploy "$RR_DEPLOY" >/dev/null 2>&1 \
  || fail "missing deploy/$RR_DEPLOY — run apply-split-deploy.sh"
# restore Warm if a prior run left it at 0
kubectl -n "$RR_NS" scale deploy/"$RR_DEPLOY" --replicas=2 >/dev/null
kubectl -n "$RR_NS" rollout status deploy/"$RR_DEPLOY" --timeout=120s
ready=$(kubectl -n "$RR_NS" get deploy "$RR_DEPLOY" -o jsonpath='{.status.readyReplicas}')
[[ "${ready:-0}" -ge 2 ]] || fail "readyReplicas want >=2 got ${ready:-0}"
ok "deploy/$RR_DEPLOY readyReplicas=$ready"

LAST_OUT=""
run_inner() {
  local id="$1"
  new_probe_pod
  kubectl -n "$NATS_NS" cp "$INNER" "$POD:/tmp/smoke-sync-rpc-inner.sh"
  # Keep POD in this shell (avoid $(...) subshell) so timing can reuse the probe.
  LAST_OUT=$(kubectl -n "$NATS_NS" exec "$POD" -- \
    env NATS_URL="$NATS_URL" SMOKE_ID="$id" sh /tmp/smoke-sync-rpc-inner.sh)
  printf '%s\n' "$LAST_OUT"
}

echo "== Warm Core RR =="
run_inner "$SMOKE_ID"
echo "$LAST_OUT" | grep -q OK_RR || fail "Warm RR missing OK_RR"
ok "Warm RR aura.rpc.smoke → rpc.smoke.done"

echo "== Warm single-hop timing (n=20) =="
# reuse probe pod for latency samples (SID via env — avoid kubectl argv quote mangling)
[[ -n "${POD:-}" ]] || fail "probe pod missing after Warm RR"
samples=""
for i in $(seq 1 20); do
  sid="${SMOKE_ID}-p$i"
  line=$(kubectl -n "$NATS_NS" exec "$POD" -- \
    env NATS_URL="$NATS_URL" SID="$sid" \
    sh -c 'nats req -s "$NATS_URL" aura.rpc.smoke "{\"id\":\"$SID\"}" --timeout=3s' 2>&1) \
    || fail "timing req $i: $line"
  echo "$line" | grep -q rpc.smoke.done || fail "timing type $i: $line"
  rtt=$(echo "$line" | sed -n 's/.*Received with rtt \([^ ]*\).*/\1/p' | head -1)
  samples="${samples}${rtt}"$'\n'
done
p95=$(SAMPLES="$samples" python3 - <<'PY'
import os, re
raw = os.environ.get("SAMPLES", "").strip().splitlines()
vals = []
for s in raw:
    s = s.strip()
    if not s:
        continue
    m = re.match(r'^([0-9.]+)(µs|us|ms|s)$', s)
    if not m:
        continue
    v = float(m.group(1))
    u = m.group(2)
    if u in ('µs', 'us'):
        v /= 1000.0  # ms
    elif u == 's':
        v *= 1000.0
    vals.append(v)
if not vals:
    print('NA'); raise SystemExit(0)
vals.sort()
idx = max(0, int(round(0.95 * (len(vals) - 1))))
print(f"{vals[idx]:.3f}ms n={len(vals)}")
PY
)
ok "Warm hop p95≈$p95 (target <1–2s; Core local)"

echo "== scale responders → 0 (No Responders regression) =="
kubectl -n "$RR_NS" scale deploy/"$RR_DEPLOY" --replicas=0 >/dev/null
# wait until no ready pods
for i in $(seq 1 30); do
  r=$(kubectl -n "$RR_NS" get deploy "$RR_DEPLOY" -o jsonpath='{.status.readyReplicas}')
  [[ -z "$r" || "$r" == "0" ]] && break
  sleep 1
done
sleep 1
new_probe_pod
nr=$(kubectl -n "$NATS_NS" exec "$POD" -- \
  nats req -s "$NATS_URL" aura.rpc.smoke '{"id":"expect-no-responder"}' --timeout=2s 2>&1 || true)
echo "$nr"
echo "$nr" | grep -qi 'no responders' || fail "expected No Responders when replicas=0"
ok "replicas=0 → No Responders"

echo "== restore Warm + RR =="
kubectl -n "$RR_NS" scale deploy/"$RR_DEPLOY" --replicas=2 >/dev/null
kubectl -n "$RR_NS" rollout status deploy/"$RR_DEPLOY" --timeout=120s
run_inner "${SMOKE_ID}-restore"
echo "$LAST_OUT" | grep -q OK_RR || fail "restore RR missing OK_RR"
ok "replicas=2 restored → RR ok"

echo "== one-pod loss still RR (queue HA) =="
pod1=$(kubectl -n "$RR_NS" get pod -l app.kubernetes.io/name=aura-rpc-smoke-rr -o jsonpath='{.items[0].metadata.name}')
[[ -n "$pod1" ]] || fail "no rr pod"
kubectl -n "$RR_NS" delete pod "$pod1" --wait=false >/dev/null
# brief settle; remaining replica should answer
sleep 1
run_inner "${SMOKE_ID}-ha"
echo "$LAST_OUT" | grep -q OK_RR || fail "HA RR missing OK_RR"
ok "deleted $pod1; remaining replica answered"
kubectl -n "$RR_NS" rollout status deploy/"$RR_DEPLOY" --timeout=120s >/dev/null

echo
ok "aura.rpc.smoke Core RR V0.2"
echo "smoke-sync-rpc: PASS"
