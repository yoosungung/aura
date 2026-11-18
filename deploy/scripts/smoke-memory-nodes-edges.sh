#!/usr/bin/env bash
# Live smoke: apply memory_nodes/edges DDL via pooler + RLS + edge indexes
# (tickets fa6351fa · 8d3fb9cd). Static only: SMOKE_MEMORY_NODES_EDGES_STATIC=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_NODES_EDGES_POD:-aura-smoke-memory-nodes-edges}"
PGIMAGE="${SMOKE_MEMORY_NODES_EDGES_IMAGE:-postgres:16-alpine}"
SQL="$ROOT/deploy/sql/memory_nodes_edges.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0 static =="
bash "$ROOT/deploy/scripts/check-memory-nodes-edges.sh"
bash "$ROOT/deploy/scripts/check-memory-graph-traversal.sh"

if [[ "${SMOKE_MEMORY_NODES_EDGES_STATIC:-}" == "1" ]]; then
  echo "smoke-memory-nodes-edges: PASS (static only)"
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

VERIFY_SQL=$(cat <<EOF
BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
INSERT INTO memory_nodes (tenant_id, entity_type, name)
  VALUES ('${TENANT_A}', 'person', 'alice'),
         ('${TENANT_A}', 'org', 'acme');
INSERT INTO memory_edges (tenant_id, source_node_id, target_node_id, relation_type)
  SELECT '${TENANT_A}', s.id, t.id, 'works_at'
  FROM memory_nodes s, memory_nodes t
  WHERE s.tenant_id = '${TENANT_A}' AND s.entity_type = 'person' AND s.name = 'alice'
    AND t.tenant_id = '${TENANT_A}' AND t.entity_type = 'org' AND t.name = 'acme';
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
INSERT INTO memory_nodes (tenant_id, entity_type, name)
  VALUES ('${TENANT_B}', 'person', 'bob');
SELECT 'b_sees_a_nodes=' || count(*)::text FROM memory_nodes WHERE tenant_id = '${TENANT_A}';
SELECT 'b_sees_a_edges=' || count(*)::text FROM memory_edges WHERE tenant_id = '${TENANT_A}';
SELECT 'b_sees_own_nodes=' || count(*)::text FROM memory_nodes WHERE tenant_id = '${TENANT_B}';
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
SELECT 'a_nodes=' || count(*)::text FROM memory_nodes WHERE tenant_id = '${TENANT_A}';
SELECT 'a_edges=' || count(*)::text FROM memory_edges WHERE tenant_id = '${TENANT_A}';
COMMIT;

SELECT 'idx_out=' || count(*)::text FROM pg_indexes
  WHERE tablename = 'memory_edges' AND indexname = 'idx_memory_edges_out';
SELECT 'idx_in=' || count(*)::text FROM pg_indexes
  WHERE tablename = 'memory_edges' AND indexname = 'idx_memory_edges_in';
SELECT 'idx_out_pred=' || CASE WHEN indexdef ILIKE '%valid_until IS NULL%' THEN 'partial' ELSE 'missing' END
  FROM pg_indexes WHERE indexname = 'idx_memory_edges_out';
SELECT 'idx_in_pred=' || CASE WHEN indexdef ILIKE '%valid_until IS NULL%' THEN 'partial' ELSE 'missing' END
  FROM pg_indexes WHERE indexname = 'idx_memory_edges_in';
EOF
)

FULL_SQL="$(cat "$SQL")
${VERIFY_SQL}"

echo "== 2 apply DDL + RLS via pooler =="
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

printf '%s\n' "$OUT" | grep -qx 'b_sees_a_nodes=0' || fail "RLS: B must not see A nodes:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'b_sees_a_edges=0' || fail "RLS: B must not see A edges:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'b_sees_own_nodes=1' || fail "RLS: B must see own node:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'a_nodes=2' || fail "A must see 2 nodes:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'a_edges=1' || fail "A must see 1 edge:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'idx_out=1' || fail "idx_memory_edges_out missing:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'idx_in=1' || fail "idx_memory_edges_in missing:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'idx_out_pred=partial' || fail "idx_memory_edges_out not partial:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'idx_in_pred=partial' || fail "idx_memory_edges_in not partial:
$OUT"

ok "nodes/edges + RLS + out/in partial indexes via pooler"
echo "smoke-memory-nodes-edges: PASS"
