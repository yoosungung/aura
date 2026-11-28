#!/usr/bin/env bash
# Lab E2E: Gateway invoke → SSE authorize → 403/404 via in-cluster Service DNS.
# Base: http://aura-gateway.aura.svc.cluster.local:8080 (port-forward 금지).
# Static only: SMOKE_GATEWAY_AGENT_INVOKE_STATIC=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
DOC="$ROOT/deploy/docs/gateway-agent-invoke-e2e.md"
INNER="$ROOT/deploy/scripts/smoke-gateway-agent-invoke-inner.sh"
GW_DEPLOY="${GW_DEPLOY:-aura-gateway}"
GATEWAY_BASE="${GATEWAY_BASE:-http://aura-gateway.${NS}.svc.cluster.local:8080}"
CURL_IMAGE="${SMOKE_GATEWAY_CURL_IMAGE:-curlimages/curl:8.5.0}"
POD=""

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0/2 static (doc + scripts + contract markers) =="
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$INNER" ]] || fail "missing $INNER"
grep -q 'aura-gateway.aura.svc.cluster.local:8080' "$DOC" || fail "doc must pin in-cluster Gateway DNS"
grep -Eqi 'port-forward 금지|port-forward.*금지' "$DOC" || fail "doc must forbid port-forward"
grep -q 'SOFT_SKIP_SSE_PUMP\|soft-skip\|stream_pump_deferred' "$DOC" || fail "doc must note SSE pump soft-skip"
grep -q '/v1/agent/invoke' "$DOC" || fail "doc must name invoke path"
grep -q '403' "$DOC" || fail "doc must name 403"
grep -q 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -q 'admin-ui Chat' "$DOC" || fail "doc Non-goals must exclude admin-ui Chat"
grep -q 'GATEWAY_BASE' "$INNER" || fail "inner must honor GATEWAY_BASE"
grep -q 'OK_INVOKE_202' "$INNER" || fail "inner must emit OK_INVOKE_202"
grep -q 'OK_EVENTS_403' "$INNER" || fail "inner must emit OK_EVENTS_403"
grep -q 'SOFT_SKIP_SSE_PUMP' "$INNER" || fail "inner must soft-skip SSE pump"
ok "doc + inner contract markers"

if [[ "${SMOKE_GATEWAY_AGENT_INVOKE_STATIC:-}" == "1" ]]; then
  echo
  echo "smoke-gateway-agent-invoke: PASS (static only)"
  exit 0
fi

need kubectl
need python3
[[ -x "$INNER" ]] || chmod +x "$INNER"

cleanup() {
  if [[ -n "${POD:-}" ]]; then
    kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== 1/2 cluster Gateway Ready =="
kubectl -n "$NS" get deploy "$GW_DEPLOY" >/dev/null 2>&1 \
  || fail "missing deploy/$GW_DEPLOY — apply gateway manifests"
kubectl -n "$NS" rollout status "deploy/$GW_DEPLOY" --timeout=120s \
  || fail "deploy/$GW_DEPLOY not Ready"
ready=$(kubectl -n "$NS" get deploy "$GW_DEPLOY" -o jsonpath='{.status.readyReplicas}')
[[ "${ready:-0}" -ge 1 ]] || fail "readyReplicas want >=1 got ${ready:-0}"
kubectl -n "$NS" get svc aura-gateway >/dev/null 2>&1 || fail "missing svc/aura-gateway"
ok "deploy/$GW_DEPLOY readyReplicas=$ready · base=$GATEWAY_BASE"

POD="aura-smoke-gw-invoke-$$"
kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
kubectl -n "$NS" run "$POD" --restart=Never --image="$CURL_IMAGE" \
  --command -- sleep 3600 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=60s >/dev/null
kubectl -n "$NS" cp "$INNER" "$POD:/tmp/smoke-gateway-agent-invoke-inner.sh"

echo "== 2/2 in-cluster invoke + authorize =="
OUT=$(kubectl -n "$NS" exec "$POD" -- \
  env GATEWAY_BASE="$GATEWAY_BASE" \
      AURA_TENANT_ID="${AURA_TENANT_ID:-11111111-1111-1111-1111-111111111111}" \
      AURA_PRINCIPAL_ID="${AURA_PRINCIPAL_ID:-smoke-principal-a}" \
      AURA_PRINCIPAL_OTHER="${AURA_PRINCIPAL_OTHER:-smoke-principal-b}" \
  sh /tmp/smoke-gateway-agent-invoke-inner.sh)
printf '%s\n' "$OUT"

echo "$OUT" | grep -q OK_INVOKE_202 || fail "missing OK_INVOKE_202"
echo "$OUT" | grep -q OK_EVENTS_OWNER || fail "missing OK_EVENTS_OWNER"
echo "$OUT" | grep -q OK_EVENTS_403 || fail "missing OK_EVENTS_403"
echo "$OUT" | grep -q OK_EVENTS_404 || fail "missing OK_EVENTS_404"
echo "$OUT" | grep -q INNER_PASS || fail "missing INNER_PASS"

run_id=$(echo "$OUT" | sed -n 's/^RUN_ID=//p' | head -1)
[[ -n "$run_id" ]] || fail "missing RUN_ID"
python3 - "$run_id" <<'PY'
import sys, uuid
rid = sys.argv[1]
try:
    u = uuid.UUID(rid)
except Exception as e:
    raise SystemExit(f"run_id not UUID: {rid}: {e}")
if u.version != 7:
    raise SystemExit(f"run_id want UUIDv7 got version={u.version}: {rid}")
print(f"OK_UUIDV7={rid}")
PY

if echo "$OUT" | grep -q SOFT_SKIP_SSE_PUMP; then
  ok "SSE frame pump deferred (authorize-only) — soft-skip"
fi

echo
echo "smoke-gateway-agent-invoke: PASS"
