#!/usr/bin/env bash
# Live smoke: apply memory_items DDL via pooler + attach seed months + RLS (ticket a181ec17).
# Static only: SMOKE_MEMORY_ITEMS_STATIC=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_ITEMS_POD:-aura-smoke-memory-items}"
PGIMAGE="${SMOKE_MEMORY_ITEMS_IMAGE:-postgres:16-alpine}"
SQL="$ROOT/deploy/sql/memory_items.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0 static =="
bash "$ROOT/deploy/scripts/check-memory-items.sh"

if [[ "${SMOKE_MEMORY_ITEMS_STATIC:-}" == "1" ]]; then
  echo "smoke-memory-items: PASS (static only)"
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
from calendar import monthrange

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
    for kind in ("short_term", "episodic"):
        parent = f"memory_items_{kind}"
        child = f"{parent}_{tag}"
        stmts.append(
            f"CREATE TABLE IF NOT EXISTS {child} PARTITION OF {parent} "
            f"FOR VALUES FROM ('{start.isoformat()}') TO ('{end.isoformat()}');"
        )
print("\n".join(stmts))
PY
)"

VERIFY_SQL=$(cat <<EOF
BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
INSERT INTO memory_items (tenant_id, memory_type, content, session_id)
  VALUES ('${TENANT_A}', 'short_term', 'st-a', 's1'),
         ('${TENANT_A}', 'long_term', 'lt-a', NULL),
         ('${TENANT_A}', 'episodic', 'ep-a', NULL),
         ('${TENANT_A}', 'semantic', 'sem-a', NULL);
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
INSERT INTO memory_items (tenant_id, memory_type, content)
  VALUES ('${TENANT_B}', 'long_term', 'lt-b');
-- A rows must be hidden
SELECT 'b_sees_a=' || count(*)::text FROM memory_items WHERE tenant_id = '${TENANT_A}';
SELECT 'b_sees_own=' || count(*)::text FROM memory_items WHERE tenant_id = '${TENANT_B}';
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
SELECT 'a_types=' || string_agg(memory_type::text, ',' ORDER BY memory_type::text)
  FROM memory_items WHERE tenant_id = '${TENANT_A}';
SELECT 'part_short=' || c.relname
  FROM memory_items i
  JOIN pg_class c ON c.oid = i.tableoid
  WHERE i.memory_type = 'short_term' AND i.tenant_id = '${TENANT_A}'
  LIMIT 1;
SELECT 'part_long=' || c.relname
  FROM memory_items i
  JOIN pg_class c ON c.oid = i.tableoid
  WHERE i.memory_type = 'long_term' AND i.tenant_id = '${TENANT_A}'
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
printf '%s\n' "$OUT" | grep -E '^a_types=episodic,long_term,semantic,short_term$' >/dev/null \
  || fail "A must see all four types:
$OUT"
printf '%s\n' "$OUT" | grep -E '^part_short=memory_items_short_term_[0-9]{4}_[0-9]{2}$' >/dev/null \
  || fail "short_term must land in monthly child:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'part_long=memory_items_long_term' \
  || fail "long_term must land in LIST leaf:
$OUT"

ok "LIST + monthly RANGE routing + RLS via pooler"
echo "smoke-memory-items: PASS"
