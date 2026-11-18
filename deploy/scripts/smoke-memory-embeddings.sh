#!/usr/bin/env bash
# Live smoke: memory_embeddings LIST + fixture partition HNSW + generation swap (ticket 0d7a4200).
# Static only: SMOKE_MEMORY_EMBEDDINGS_STATIC=1
# Fixture model_key only — not production AURA_EMBEDDING_*.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_EMBEDDINGS_POD:-aura-smoke-memory-embeddings}"
PGIMAGE="${SMOKE_MEMORY_EMBEDDINGS_IMAGE:-pgvector/pgvector:pg16}"
SQL="$ROOT/deploy/sql/memory_embeddings.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"
# Tiny fixture dims (≠ production). halfvec literal length must match.
FIX_DIMS=3
FIX_V1="fixture:v1"
FIX_V2="fixture:v2"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0 static =="
bash "$ROOT/deploy/scripts/check-memory-embeddings.sh"

if [[ "${SMOKE_MEMORY_EMBEDDINGS_STATIC:-}" == "1" ]]; then
  echo "smoke-memory-embeddings: PASS (static only)"
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

# Generation swap dry-run with fixture partitions (ATTACH v1 → insert → ATTACH v2 → DETACH v1).
VERIFY_SQL=$(cat <<EOF
CREATE TABLE memory_embeddings_p_fixture_v1 PARTITION OF memory_embeddings
  FOR VALUES IN ('${FIX_V1}');
ALTER TABLE memory_embeddings_p_fixture_v1
  ADD CONSTRAINT memory_embeddings_p_fixture_v1_dims CHECK (dims = ${FIX_DIMS});
CREATE INDEX memory_embeddings_p_fixture_v1_hnsw
  ON memory_embeddings_p_fixture_v1
  USING hnsw ((embedding::halfvec(${FIX_DIMS})) halfvec_cosine_ops);

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
INSERT INTO memory_embeddings (item_id, tenant_id, memory_type, model, version, model_key, dims, embedding)
  VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '${TENANT_A}',
    'long_term',
    'fixture',
    'v1',
    '${FIX_V1}',
    ${FIX_DIMS},
    '[0.1,0.2,0.3]'::halfvec
  );
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_B}', true);
SELECT 'b_sees_a=' || count(*)::text FROM memory_embeddings WHERE tenant_id = '${TENANT_A}';
COMMIT;

CREATE TABLE memory_embeddings_p_fixture_v2 PARTITION OF memory_embeddings
  FOR VALUES IN ('${FIX_V2}');
ALTER TABLE memory_embeddings_p_fixture_v2
  ADD CONSTRAINT memory_embeddings_p_fixture_v2_dims CHECK (dims = ${FIX_DIMS});
CREATE INDEX memory_embeddings_p_fixture_v2_hnsw
  ON memory_embeddings_p_fixture_v2
  USING hnsw ((embedding::halfvec(${FIX_DIMS})) halfvec_cosine_ops);

ALTER TABLE memory_embeddings DETACH PARTITION memory_embeddings_p_fixture_v1;
DROP TABLE memory_embeddings_p_fixture_v1;

SELECT 'parts_v2=' || count(*)::text FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'memory_embeddings' AND c.relname = 'memory_embeddings_p_fixture_v2';
SELECT 'parts_v1_gone=' || count(*)::text FROM pg_class WHERE relname = 'memory_embeddings_p_fixture_v1';
SELECT 'idx_v2=' || count(*)::text FROM pg_indexes
  WHERE indexname = 'memory_embeddings_p_fixture_v2_hnsw';
EOF
)

FULL_SQL="$(cat "$SQL")
${VERIFY_SQL}"

echo "== 2 apply DDL + fixture generation swap via pooler =="
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

printf '%s\n' "$OUT" | grep -qx 'b_sees_a=0' || fail "RLS: B must not see A embeds:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'parts_v2=1' || fail "fixture v2 partition missing after swap:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'parts_v1_gone=0' || fail "fixture v1 should be dropped after DETACH:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'idx_v2=1' || fail "fixture v2 HNSW missing:
$OUT"

ok "embeddings LIST + RLS + fixture ATTACH/switch/DETACH via pooler"
echo "smoke-memory-embeddings: PASS"
