#!/usr/bin/env bash
# V1.1 live smoke: Pooler transaction + set_config(..., true) + RLS (ticket 92cccf21).
# Cases: (a) DSN=pooler only (b) poolMode=transaction (c) reuse → no cross-tenant
#        (d) no set_config(..., false) / session SET app.tenant_id in executable paths.
# Static gate (no cluster): SMOKE_PG_POOLER_STATIC=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_PG_POOLER_POD:-aura-smoke-pg-pooler}"
PGIMAGE="${SMOKE_PG_POOLER_IMAGE:-postgres:16-alpine}"
FIXTURE="$ROOT/deploy/k8s/pg-pooler/rls-smoke-fixture.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

expect_line() {
  local haystack="$1" needle="$2"
  printf '%s\n' "$haystack" | grep -qxF "$needle" || fail "missing marker '$needle' in:
$haystack"
}

echo "== 0/3 static (check-pg-pooler + fixture + forbid session GUC) =="
bash "$ROOT/deploy/scripts/check-pg-pooler.sh"
[[ -f "$FIXTURE" ]] || fail "missing fixture $FIXTURE"
grep -q 'FORCE ROW LEVEL SECURITY' "$FIXTURE" || fail "fixture must FORCE ROW LEVEL SECURITY"
grep -q "current_setting('app.tenant_id'" "$FIXTURE" || fail "fixture must use app.tenant_id GUC"

# (d) executable / schema paths must not use session-scoped tenant GUC.
SCAN_ROOTS=(
  "$ROOT/deploy/k8s"
  "$ROOT/deploy/scripts"
)
if [[ -d "$ROOT/services" ]]; then
  SCAN_ROOTS+=("$ROOT/services")
fi
BAD_HITS="$(
  grep -RIn --include='*.sql' --include='*.sh' --include='*.ts' --include='*.js' --include='*.py' \
    -E "set_config\(\s*'app\.tenant_id'\s*,[^,]+,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" \
    "${SCAN_ROOTS[@]}" 2>/dev/null \
    | grep -v 'smoke-pg-pooler\.sh' \
    | grep -v 'pg-pooler-smoke-plan\.md' \
    || true
)"
[[ -z "$BAD_HITS" ]] || fail "forbidden session tenant GUC paths:
$BAD_HITS"
ok "no set_config(..., false) / SET app.tenant_id in scan roots"

if [[ "${SMOKE_PG_POOLER_STATIC:-}" == "1" ]]; then
  echo
  echo "smoke-pg-pooler: PASS (static only)"
  exit 0
fi

need kubectl
need python3

echo "== 1/3 cluster Pooler + DSN (a)(b) =="
kubectl -n "$NS" get cluster.postgresql.cnpg.io/aura-pg >/dev/null 2>&1 \
  || fail "Cluster aura-pg missing — run install-pg-pooler.sh"
kubectl -n "$NS" get pooler.postgresql.cnpg.io/aura-pg-pooler >/dev/null 2>&1 \
  || fail "Pooler aura-pg-pooler missing — run install-pg-pooler.sh"
kubectl -n "$NS" wait --for=condition=Ready cluster.postgresql.cnpg.io/aura-pg --timeout=120s \
  || fail "Cluster aura-pg not Ready"
kubectl -n "$NS" rollout status deployment/aura-pg-pooler --timeout=120s \
  || fail "Pooler deployment not Ready"

MODE="$(kubectl -n "$NS" get pooler.postgresql.cnpg.io/aura-pg-pooler -o jsonpath='{.spec.pgbouncer.poolMode}')"
[[ "$MODE" == "transaction" ]] || fail "live poolMode want transaction got ${MODE:-empty}"
ok "live poolMode=transaction"

HOST="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_HOST}')"
[[ "$HOST" == *aura-pg-pooler* ]] || fail "AURA_DATABASE_HOST must be pooler (got ${HOST:-empty})"
for forbidden in aura-pg-rw aura-pg-r aura-pg-ro; do
  [[ "$HOST" != *"$forbidden"* ]] || fail "AURA_DATABASE_HOST must not be $forbidden"
done
ok "live DSN host=$HOST (pooler only)"

PORT="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_PORT}')"
DBNAME="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_NAME}')"
DBUSER="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_USER}')"
[[ -n "$PORT" && -n "$DBNAME" && -n "$DBUSER" ]] || fail "aura-pg-dsn incomplete"
PASS="$(kubectl -n "$NS" get secret aura-pg-app -o jsonpath='{.data.password}' | python3 -c 'import sys,base64; print(base64.b64decode(sys.stdin.read().strip()).decode())')"
[[ -n "$PASS" ]] || fail "aura-pg-app password empty"

echo "== 2/3 apply fixture + RLS reuse via pooler (c) =="
cleanup() { kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT

kubectl -n "$NS" run "$POD" --restart=Never --image="$PGIMAGE" \
  --env="PGHOST=$HOST" \
  --env="PGPORT=$PORT" \
  --env="PGDATABASE=$DBNAME" \
  --env="PGUSER=$DBUSER" \
  --env="PGPASSWORD=$PASS" \
  --command -- sleep 300
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=120s

kubectl -n "$NS" cp "$FIXTURE" "$POD:/tmp/rls-smoke-fixture.sql"
kubectl -n "$NS" exec "$POD" -- psql -q -v ON_ERROR_STOP=1 -f /tmp/rls-smoke-fixture.sql >/dev/null
ok "fixture applied via pooler"

# Unique labels avoid cross-talk if two smokes overlap on the same Cluster.
RUN_ID="${SMOKE_PG_POOLER_RUN_ID:-r$(date +%s)-$$}"
LABEL_A="row-a-${RUN_ID}"
LABEL_B="row-b-${RUN_ID}"

# One TCP session, two transactions — COMMIT clears is_local GUC (pool-safe).
# Markers only: set_config return text / BEGIN|COMMIT tags may also appear.
LIVE_OUT="$(kubectl -n "$NS" exec -i "$POD" -- \
  psql -q -v ON_ERROR_STOP=1 \
    -v "TENANT_A=$TENANT_A" -v "TENANT_B=$TENANT_B" \
    -v "LABEL_A=$LABEL_A" -v "LABEL_B=$LABEL_B" -At <<'SQL'
BEGIN;
SELECT set_config('app.tenant_id', :'TENANT_A', true);
INSERT INTO smoke_tenant_rows (tenant_id, label) VALUES (:'TENANT_A'::uuid, :'LABEL_A');
SELECT 'A_SEE_OWN=' || count(*)::text FROM smoke_tenant_rows WHERE label = :'LABEL_A';
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :'TENANT_B', true);
SELECT 'B_SEE_A=' || count(*)::text FROM smoke_tenant_rows WHERE label = :'LABEL_A';
SELECT 'B_BEFORE=' || count(*)::text FROM smoke_tenant_rows WHERE label IN (:'LABEL_A', :'LABEL_B');
INSERT INTO smoke_tenant_rows (tenant_id, label) VALUES (:'TENANT_B'::uuid, :'LABEL_B');
SELECT 'B_SEE_OWN=' || count(*)::text FROM smoke_tenant_rows WHERE label = :'LABEL_B';
COMMIT;

SELECT 'GUC_CLEARED=' || (COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '') = '')::text;
SELECT 'NO_TENANT=' || count(*)::text FROM smoke_tenant_rows WHERE label IN (:'LABEL_A', :'LABEL_B');
SQL
)" || fail "psql live transactions failed"

expect_line "$LIVE_OUT" "A_SEE_OWN=1"
expect_line "$LIVE_OUT" "B_SEE_A=0"
expect_line "$LIVE_OUT" "B_BEFORE=0"
expect_line "$LIVE_OUT" "B_SEE_OWN=1"
expect_line "$LIVE_OUT" "GUC_CLEARED=true"
expect_line "$LIVE_OUT" "NO_TENANT=0"
ok "pool reuse: B never sees A; GUC local cleared after COMMIT"

echo "== 3/3 second session still isolated (pool server conn reuse) =="
SECOND="$(kubectl -n "$NS" exec -i "$POD" -- \
  psql -q -v ON_ERROR_STOP=1 \
    -v "TENANT_B=$TENANT_B" -v "LABEL_A=$LABEL_A" -v "LABEL_B=$LABEL_B" -At <<'SQL'
BEGIN;
SELECT set_config('app.tenant_id', :'TENANT_B', true);
SELECT 'S2_SEE_A=' || count(*)::text FROM smoke_tenant_rows WHERE label = :'LABEL_A';
SELECT 'S2_SEE_B=' || count(*)::text FROM smoke_tenant_rows WHERE label = :'LABEL_B';
COMMIT;
SQL
)" || fail "second session psql failed"
expect_line "$SECOND" "S2_SEE_A=0"
expect_line "$SECOND" "S2_SEE_B=1"
ok "second session isolation holds"

echo
echo "smoke-pg-pooler: PASS"
echo "  (a) DSN host=$HOST"
echo "  (b) poolMode=transaction"
echo "  (c) A→COMMIT→B via pooler: cross-tenant hidden"
echo "  (d) static forbid session GUC paths"
