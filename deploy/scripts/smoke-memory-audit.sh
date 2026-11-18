#!/usr/bin/env bash
# Live smoke: apply memory_audit DDL via pooler + attach seed months + RLS (ticket 85741c7b).
# Static only: SMOKE_MEMORY_AUDIT_STATIC=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_AUDIT_POD:-aura-smoke-memory-audit}"
PGIMAGE="${SMOKE_MEMORY_AUDIT_IMAGE:-postgres:16-alpine}"
SQL="$ROOT/deploy/sql/memory_audit.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0 static =="
bash "$ROOT/deploy/scripts/check-memory-audit.sh"

if [[ "${SMOKE_MEMORY_AUDIT_STATIC:-}" == "1" ]]; then
  echo "smoke-memory-audit: PASS (static only)"
  exit 0
fi

need kubectl
need python3

echo "== 1 cluster + pooler DSN =="
kubectl -n "$NS" get cluster.postgresql.cnpg.io/aura-pg >/dev/null 2>&1 \
  || fail "Cluster aura-pg missing"
kubectl -n "$NS" get pooler.postgresql.cnpg.io/aura-pg-pooler >/dev/null 2>&1 \
  || fail "Pooler aura-pg-pooler missing"
kubectl -n "$NS" wait --for=condition=Ready cluster.postgresql.cnpg.io/aura-pg --timeout=120s \
  || fail "Cluster aura-pg not Ready"

HOST="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_HOST}')"
[[ "$HOST" == *aura-pg-pooler* ]] || fail "AURA_DATABASE_HOST must be pooler (got ${HOST:-empty})"
PORT="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_PORT}')"
DBNAME="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_NAME}')"
DBUSER="$(kubectl -n "$NS" get configmap aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_USER}')"
PASS="$(kubectl -n "$NS" get secret aura-pg-app -o jsonpath='{.data.password}' | python3 -c 'import sys,base64; print(base64.b64decode(sys.stdin.read().strip()).decode())')"
[[ -n "$PORT" && -n "$DBNAME" && -n "$DBUSER" && -n "$PASS" ]] || fail "DSN incomplete"
ok "DSN host=$HOST"

# UTC month seed: prev, current, next
MONTH_SQL="$(python3 - <<'PY'
from datetime import date

def first(d: date) -> date:
    return d.replace(day=1)

def add_month(d: date, n: int) -> date:
    y, m = d.year, d.month + n
    while m > 12:
        y += 1
        m -= 12
    while m < 1:
        y -= 1
        m += 12
    return date(y, m, 1)

today = date.today()
cur = first(today)
months = [add_month(cur, -1), cur, add_month(cur, 1)]
stmts = []
for start in months:
    end = add_month(start, 1)
    tag = start.strftime("%Y_%m")
    child = f"memory_audit_{tag}"
    stmts.append(
        f"CREATE TABLE IF NOT EXISTS {child} PARTITION OF memory_audit "
        f"FOR VALUES FROM ('{start.isoformat()}') TO ('{end.isoformat()}');"
    )
print("\n".join(stmts))
PY
)"

VERIFY_SQL=$(cat <<EOF
BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
INSERT INTO memory_audit (tenant_id, item_id, action, detail)
  VALUES ('${TENANT_A}', NULL, 'capture', '{"src":"smoke-a"}'::jsonb);
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
INSERT INTO memory_audit (tenant_id, action, detail)
  VALUES ('${TENANT_B}', 'recall', '{"src":"smoke-b"}'::jsonb);
SELECT 'b_sees_a=' || count(*)::text FROM memory_audit WHERE tenant_id = '${TENANT_A}';
SELECT 'b_sees_own=' || count(*)::text FROM memory_audit WHERE tenant_id = '${TENANT_B}';
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
SELECT 'a_own=' || count(*)::text FROM memory_audit WHERE tenant_id = '${TENANT_A}';
SELECT 'part_a=' || c.relname
  FROM memory_audit i
  JOIN pg_class c ON c.oid = i.tableoid
  WHERE i.tenant_id = '${TENANT_A}'
  LIMIT 1;
COMMIT;
EOF
)

FULL_SQL="$(cat "$SQL")
${MONTH_SQL}
${VERIFY_SQL}"

echo "== 2 apply DDL + seed months + RLS via pooler =="
cleanup() { kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT

kubectl -n "$NS" run "$POD" --restart=Never --image="$PGIMAGE" \
  --env="PGHOST=$HOST" \
  --env="PGPORT=$PORT" \
  --env="PGDATABASE=$DBNAME" \
  --env="PGUSER=$DBUSER" \
  --env="PGPASSWORD=$PASS" \
  --command -- sleep 600 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=120s || fail "smoke pod not Ready"

OUT="$(printf '%s\n' "$FULL_SQL" | kubectl -n "$NS" exec -i "$POD" -- \
  psql -v ON_ERROR_STOP=1 -At 2>&1)" || fail "psql apply failed:
$OUT"

printf '%s\n' "$OUT" | grep -qx 'b_sees_a=0' || fail "RLS: B must not see A (got):
$OUT"
printf '%s\n' "$OUT" | grep -qx 'b_sees_own=1' || fail "RLS: B must see own row:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'a_own=1' || fail "A must see own row:
$OUT"
printf '%s\n' "$OUT" | grep -E '^part_a=memory_audit_[0-9]{4}_[0-9]{2}$' >/dev/null \
  || fail "row must land in monthly child:
$OUT"

ok "monthly RANGE routing + RLS via pooler"
echo "smoke-memory-audit: PASS"
