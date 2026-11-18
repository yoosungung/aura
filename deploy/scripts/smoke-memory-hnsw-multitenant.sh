#!/usr/bin/env bash
# Live/static smoke: large A + small B HNSW — ON>=1 / OFF=0 (ticket fbed0ce9).
# Static only: SMOKE_MEMORY_HNSW_MT_STATIC=1
# Fixture model_key only — not production AURA_EMBEDDING_*.
# On ON<1: FAIL — escalate T1/T2 per deploy/docs/memory-hnsw-multitenant-fixture.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_HNSW_MT_POD:-aura-smoke-memory-hnsw-mt}"
PGIMAGE="${SMOKE_MEMORY_HNSW_MT_IMAGE:-pgvector/pgvector:pg16}"
SQL="$ROOT/deploy/sql/memory_embeddings.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"
FIX_DIMS=3
FIX_KEY="fixture:hnsw_mt"
A_ROWS=500
B_ROWS=2
TOP_K=10
Q_VEC='[1,0,0]'
A_VEC='[1,0,0]'
# Slightly farther than A so global Top-K fills with A.
B_VEC='[0.99,0.01,0]'

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0 static =="
bash "$ROOT/deploy/scripts/check-memory-hnsw-multitenant.sh"

if [[ "${SMOKE_MEMORY_HNSW_MT_STATIC:-}" == "1" ]]; then
  echo "smoke-memory-hnsw-multitenant: PASS (static only)"
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
SELECT 'ext_ver=' || extversion FROM pg_extension WHERE extname = 'vector';

-- Smoke-only: drop UNIQUE so tiny N cannot prefer btree over HNSW (prod DDL keeps UNIQUE).
ALTER TABLE memory_embeddings DROP CONSTRAINT IF EXISTS memory_embeddings_item_id_model_key_key;

CREATE TABLE memory_embeddings_p_fixture_hnsw_mt PARTITION OF memory_embeddings
  FOR VALUES IN ('${FIX_KEY}');
ALTER TABLE memory_embeddings_p_fixture_hnsw_mt
  ADD CONSTRAINT memory_embeddings_p_fixture_hnsw_mt_dims CHECK (dims = ${FIX_DIMS});
CREATE INDEX memory_embeddings_p_fixture_hnsw_mt_hnsw
  ON memory_embeddings_p_fixture_hnsw_mt
  USING hnsw ((embedding::halfvec(${FIX_DIMS})) halfvec_cosine_ops);

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
INSERT INTO memory_embeddings (item_id, tenant_id, memory_type, model, version, model_key, dims, embedding)
SELECT
  ('a0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  '${TENANT_A}',
  'long_term',
  'fixture',
  'hnsw_mt',
  '${FIX_KEY}',
  ${FIX_DIMS},
  '${A_VEC}'::halfvec
FROM generate_series(1, ${A_ROWS}) AS g;
SELECT 'a_rows=' || count(*)::text FROM memory_embeddings WHERE tenant_id = '${TENANT_A}';
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
INSERT INTO memory_embeddings (item_id, tenant_id, memory_type, model, version, model_key, dims, embedding)
SELECT
  ('b0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  '${TENANT_B}',
  'long_term',
  'fixture',
  'hnsw_mt',
  '${FIX_KEY}',
  ${FIX_DIMS},
  '${B_VEC}'::halfvec
FROM generate_series(1, ${B_ROWS}) AS g;
SELECT 'b_rows=' || count(*)::text FROM memory_embeddings WHERE tenant_id = '${TENANT_B}';
COMMIT;

ANALYZE memory_embeddings_p_fixture_hnsw_mt;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
SELECT 'b_sees_a=' || count(*)::text FROM memory_embeddings WHERE tenant_id = '${TENANT_A}';
COMMIT;

-- OFF trap: global Top-K then tenant filter (forbidden post-filter / iterative_scan=off shape).
ALTER TABLE memory_embeddings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings DISABLE ROW LEVEL SECURITY;
SET enable_seqscan = off;
SET enable_bitmapscan = off;
SET hnsw.iterative_scan = off;
SET hnsw.ef_search = 40;
SELECT 'off_b=' || count(*)::text FROM (
  SELECT tenant_id FROM (
    SELECT tenant_id
    FROM memory_embeddings
    WHERE model_key = '${FIX_KEY}'
    ORDER BY (embedding::halfvec(${FIX_DIMS})) <=> '${Q_VEC}'::halfvec
    LIMIT ${TOP_K}
  ) topk
  WHERE tenant_id = '${TENANT_B}'
) s;

-- ON: FORCE RLS + iterative_scan + WHERE tenant in one query.
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;
BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
SET LOCAL enable_seqscan = off;
SET LOCAL enable_bitmapscan = off;
SET LOCAL hnsw.iterative_scan = relaxed_order;
SET LOCAL hnsw.ef_search = 40;
SET LOCAL hnsw.max_scan_tuples = 20000;
SELECT 'on_b=' || count(*)::text FROM (
  SELECT id
  FROM memory_embeddings
  WHERE tenant_id = '${TENANT_B}'
  ORDER BY (embedding::halfvec(${FIX_DIMS})) <=> '${Q_VEC}'::halfvec
  LIMIT ${TOP_K}
) s;
COMMIT;
EOF
)

FULL_SQL="$(cat "$SQL")
${VERIFY_SQL}"

echo "== 2 apply DDL + A/B fixture + ON/OFF via pooler =="
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

set +e
OUT="$(printf '%s\n' "$FULL_SQL" | kubectl -n "$NS" exec -i "$POD" -- \
  psql -v ON_ERROR_STOP=1 -At 2>&1)"
psql_rc=$?
set -e
if [[ $psql_rc -ne 0 ]]; then
  fail "psql apply failed (rc=$psql_rc): $OUT"
fi

printf '%s\n' "$OUT" | grep -Eq '^ext_ver=0\.(8|9|[1-9][0-9])' \
  || fail "pgvector must be >= 0.8: $OUT"
printf '%s\n' "$OUT" | grep -qx "a_rows=${A_ROWS}" || fail "A seed size mismatch: $OUT"
printf '%s\n' "$OUT" | grep -qx "b_rows=${B_ROWS}" || fail "B seed size mismatch: $OUT"
printf '%s\n' "$OUT" | grep -qx 'b_sees_a=0' || fail "RLS must hide A from B: $OUT"
printf '%s\n' "$OUT" | grep -qx 'off_b=0' || fail "OFF contrast must yield B=0 (trap): $OUT"
ON_LINE="$(printf '%s\n' "$OUT" | grep -E '^on_b=[0-9]+$' | tail -n1 || true)"
[[ -n "$ON_LINE" ]] || fail "missing on_b= line: $OUT"
ON_N="${ON_LINE#on_b=}"
[[ "$ON_N" -ge 1 ]] || fail "ON path must yield B>=1 (got ${ON_N}) — escalate T1/T2: $OUT"

ok "A=${A_ROWS} B=${B_ROWS} OFF=0 ON=${ON_N} via pooler"
echo "smoke-memory-hnsw-multitenant: PASS"
