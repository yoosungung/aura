#!/usr/bin/env bash
# Live/static smoke: large A + small B HNSW — iterative_scan ON≥1 / OFF=0 (ticket fbed0ce9).
# Static only: SMOKE_MEMORY_HNSW_MT_STATIC=1
# Fixture table uses halfvec_l2_ops (cosine skew ON-gap documented in DESIGN).
# On ON<1: FAIL — escalate T1/T2 per deploy/docs/memory-hnsw-multitenant-fixture.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_HNSW_MT_POD:-aura-smoke-memory-hnsw-mt}"
PGIMAGE="${SMOKE_MEMORY_HNSW_MT_IMAGE:-pgvector/pgvector:pg16}"
A_ROWS=2000
B_ROWS=2
TOP_K=10
Q_VEC='[0,0,0]'

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
CREATE EXTENSION IF NOT EXISTS vector;
SELECT 'ext_ver=' || extversion FROM pg_extension WHERE extname = 'vector';

DROP TABLE IF EXISTS hnsw_mt_fixture;
CREATE TABLE hnsw_mt_fixture (
  id         bigserial,
  tenant_id  uuid NOT NULL,
  embedding  halfvec(3) NOT NULL
);
CREATE INDEX hnsw_mt_fixture_hnsw
  ON hnsw_mt_fixture
  USING hnsw (embedding halfvec_l2_ops);

-- Seed A near query origin.
INSERT INTO hnsw_mt_fixture (tenant_id, embedding)
SELECT
  '11111111-1111-1111-1111-111111111111'::uuid,
  format('[%s,%s,%s]',
    (0.01 * random())::text,
    (0.01 * random())::text,
    (0.01 * random())::text)::halfvec
FROM generate_series(1, ${A_ROWS});
SELECT 'a_rows=' || count(*)::text FROM hnsw_mt_fixture
  WHERE tenant_id = '11111111-1111-1111-1111-111111111111';

-- Seed B slightly farther (outside first ef_search window when OFF).
INSERT INTO hnsw_mt_fixture (tenant_id, embedding) VALUES
  ('22222222-2222-2222-2222-222222222222', '[0.2,0,0]'::halfvec),
  ('22222222-2222-2222-2222-222222222222', '[0.21,0,0]'::halfvec);
SELECT 'b_rows=' || count(*)::text FROM hnsw_mt_fixture
  WHERE tenant_id = '22222222-2222-2222-2222-222222222222';

ANALYZE hnsw_mt_fixture;

-- OFF: trap.
BEGIN;
SET LOCAL enable_seqscan = off;
SET LOCAL hnsw.iterative_scan = off;
SET LOCAL hnsw.ef_search = 40;
SET LOCAL hnsw.max_scan_tuples = 20000;
SELECT 'off_b=' || count(*)::text FROM (
  SELECT id FROM hnsw_mt_fixture
  WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
  ORDER BY embedding <-> '${Q_VEC}'::halfvec
  LIMIT ${TOP_K}
) s;
COMMIT;

-- ON: iterative_scan must recover B.
BEGIN;
SET LOCAL enable_seqscan = off;
SET LOCAL hnsw.iterative_scan = relaxed_order;
SET LOCAL hnsw.ef_search = 40;
SET LOCAL hnsw.max_scan_tuples = 20000;
SELECT 'on_b=' || count(*)::text FROM (
  SELECT id FROM hnsw_mt_fixture
  WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
  ORDER BY embedding <-> '${Q_VEC}'::halfvec
  LIMIT ${TOP_K}
) s;
COMMIT;

DROP TABLE IF EXISTS hnsw_mt_fixture;
EOF
)

echo "== 2 distorted-tenant L2 fixture ON/OFF via pooler =="
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

OUT="$(printf '%s\n' "$VERIFY_SQL" | kubectl -n "$NS" exec -i "$POD" -- \
  psql -v ON_ERROR_STOP=1 -At 2>&1)" || fail "psql apply failed:
$OUT"

printf '%s\n' "$OUT" | grep -Eq '^ext_ver=0\.(8|9|[1-9][0-9])' \
  || fail "pgvector must be ≥ 0.8:
$OUT"
printf '%s\n' "$OUT" | grep -qx "a_rows=${A_ROWS}" || fail "A seed size mismatch:
$OUT"
printf '%s\n' "$OUT" | grep -qx "b_rows=${B_ROWS}" || fail "B seed size mismatch:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'off_b=0' || fail "OFF contrast must yield B=0 (trap):
$OUT"
ON_LINE="$(printf '%s\n' "$OUT" | grep -E '^on_b=[0-9]+$' | tail -n1 || true)"
[[ -n "$ON_LINE" ]] || fail "missing on_b= line:
$OUT"
ON_N="${ON_LINE#on_b=}"
[[ "$ON_N" -ge 1 ]] || fail "ON path must yield B≥1 (got ${ON_N}) — escalate T1/T2 per DESIGN:
$OUT"

ok "A=${A_ROWS} B=${B_ROWS} OFF=0 ON=${ON_N} (halfvec_l2) via pooler"
echo "smoke-memory-hnsw-multitenant: PASS"
