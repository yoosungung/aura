#!/usr/bin/env sh
# In-cluster probe: Gateway invoke + SSE authorize + 403/404.
# Env: GATEWAY_BASE AURA_TENANT_ID AURA_PRINCIPAL_ID AURA_PRINCIPAL_OTHER
set -eu

GATEWAY_BASE="${GATEWAY_BASE:-http://aura-gateway.aura.svc.cluster.local:8080}"
TENANT="${AURA_TENANT_ID:-11111111-1111-1111-1111-111111111111}"
PRINCIPAL="${AURA_PRINCIPAL_ID:-smoke-principal-a}"
OTHER="${AURA_PRINCIPAL_OTHER:-smoke-principal-b}"
AGENT="${AURA_SMOKE_AGENT:-demo}"
VERSION="${AURA_SMOKE_AGENT_VERSION:-1.0.0}"

fail() { echo "FAIL: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "need curl"

echo "== healthz =="
hz=$(curl -sS -o /tmp/gw-hz.txt -w '%{http_code}' "$GATEWAY_BASE/healthz" || true)
[ "$hz" = "200" ] || fail "healthz want 200 got $hz"
echo "OK_HEALTHZ"

echo "== POST /v1/agent/invoke =="
inv_code=$(curl -sS -o /tmp/gw-inv.json -w '%{http_code}' \
  -X POST "$GATEWAY_BASE/v1/agent/invoke" \
  -H "content-type: application/json" \
  -H "X-Aura-Tenant-Id: $TENANT" \
  -H "X-Aura-Principal-Id: $PRINCIPAL" \
  -d "{\"agent\":\"$AGENT\",\"version\":\"$VERSION\",\"input\":{\"text\":\"smoke-e2e\"},\"session_id\":\"smoke-session\",\"stream\":true}" \
  || true)
echo "INVOKE_HTTP=$inv_code"
cat /tmp/gw-inv.json
echo
[ "$inv_code" = "202" ] || fail "invoke want 202 got $inv_code"
echo "OK_INVOKE_202"

run_id=$(sed -n 's/.*"run_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/gw-inv.json | head -1)
[ -n "$run_id" ] || fail "missing run_id"
echo "RUN_ID=$run_id"

subj=$(sed -n 's/.*"stream_subject"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/gw-inv.json | head -1)
[ "$subj" = "aura.stream.$run_id" ] || fail "stream_subject want aura.stream.$run_id got ${subj:-empty}"
echo "OK_STREAM_SUBJECT"

echo "== GET /v1/runs/:run_id/events (owner) =="
ev_code=$(curl -sS -o /tmp/gw-ev.json -w '%{http_code}' \
  "$GATEWAY_BASE/v1/runs/$run_id/events" \
  -H "X-Aura-Tenant-Id: $TENANT" \
  -H "X-Aura-Principal-Id: $PRINCIPAL" \
  || true)
echo "EVENTS_HTTP=$ev_code"
cat /tmp/gw-ev.json
echo
[ "$ev_code" = "200" ] || fail "events owner want 200 got $ev_code"
grep -q 'text/event-stream' /tmp/gw-ev.json || fail "events body must mention text/event-stream"
echo "OK_EVENTS_OWNER"

# Live SSE frame pump is authorize-only until canary; do not require token frames.
if grep -q 'stream_pump_deferred_to_canary' /tmp/gw-ev.json; then
  echo "SOFT_SKIP_SSE_PUMP"
fi

echo "== GET events (other principal) =="
forbid_code=$(curl -sS -o /tmp/gw-forbid.json -w '%{http_code}' \
  "$GATEWAY_BASE/v1/runs/$run_id/events" \
  -H "X-Aura-Tenant-Id: $TENANT" \
  -H "X-Aura-Principal-Id: $OTHER" \
  || true)
echo "FORBID_HTTP=$forbid_code"
cat /tmp/gw-forbid.json
echo
[ "$forbid_code" = "403" ] || fail "mismatch principal want 403 got $forbid_code"
grep -q 'principal_forbidden' /tmp/gw-forbid.json || fail "body must be principal_forbidden"
echo "OK_EVENTS_403"

echo "== GET events (unknown run) =="
missing_code=$(curl -sS -o /tmp/gw-missing.json -w '%{http_code}' \
  "$GATEWAY_BASE/v1/runs/00000000-0000-7000-8000-000000000000/events" \
  -H "X-Aura-Tenant-Id: $TENANT" \
  -H "X-Aura-Principal-Id: $PRINCIPAL" \
  || true)
echo "MISSING_HTTP=$missing_code"
cat /tmp/gw-missing.json
echo
[ "$missing_code" = "404" ] || fail "unknown run want 404 got $missing_code"
grep -q 'run_not_found' /tmp/gw-missing.json || fail "body must be run_not_found"
echo "OK_EVENTS_404"

echo "INNER_PASS"
