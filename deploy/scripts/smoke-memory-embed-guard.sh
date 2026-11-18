#!/usr/bin/env bash
# Live/static smoke: short_term embed refuse + undimensioned HNSW fail + pgvector≥0.8 (ticket 6dfc4c4a).
# Static only: SMOKE_MEMORY_EMBED_GUARD_STATIC=1
# Distorted-tenant iterative_scan fixture = separate ticket (non-goal here).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${AURA_NS:-aura}"
POD="${SMOKE_MEMORY_EMBED_GUARD_POD:-aura-smoke-memory-embed-guard}"
PGIMAGE="${SMOKE_MEMORY_EMBED_GUARD_IMAGE:-pgvector/pgvector:pg16}"
SQL="$ROOT/deploy/sql/memory_embeddings.sql"
TENANT_A="11111111-1111-1111-1111-111111111111"
FIX_DIMS=3
FIX_V1="fixture:v1"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }

echo "== 0 static =="
bash "$ROOT/deploy/scripts/check-memory-embed-guard.sh"

if [[ "${SMOKE_MEMORY_EMBED_GUARD_STATIC:-}" == "1" ]]; then
  echo "smoke-memory-embed-guard: PASS (static only)"
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

-- Undimensioned parent HNSW must fail (column does not have dimensions).
DO \$\$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX memory_embeddings_bad_hnsw ON memory_embeddings USING hnsw (embedding halfvec_cosine_ops)';
    RAISE EXCEPTION 'expected undimensioned HNSW to fail';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM ~* 'dimension' OR SQLERRM ~* 'halfvec' OR SQLERRM ~* 'operator' OR SQLERRM ~* 'type' THEN
        RAISE NOTICE 'undim_hnsw_fail=1';
      ELSE
        RAISE;
      END IF;
  END;
END \$\$;
SELECT 'undim_hnsw_fail=1';

CREATE TABLE memory_embeddings_p_fixture_v1 PARTITION OF memory_embeddings
  FOR VALUES IN ('${FIX_V1}');
ALTER TABLE memory_embeddings_p_fixture_v1
  ADD CONSTRAINT memory_embeddings_p_fixture_v1_dims CHECK (dims = ${FIX_DIMS});
CREATE INDEX memory_embeddings_p_fixture_v1_hnsw
  ON memory_embeddings_p_fixture_v1
  USING hnsw ((embedding::halfvec(${FIX_DIMS})) halfvec_cosine_ops);

BEGIN;
SELECT set_config('app.tenant_id', '${TENANT_A}', true);
-- short_term must be rejected by CHECK.
DO \$\$
BEGIN
  BEGIN
    INSERT INTO memory_embeddings (item_id, tenant_id, memory_type, model, version, model_key, dims, embedding)
      VALUES (
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        '${TENANT_A}',
        'short_term',
        'fixture',
        'v1',
        '${FIX_V1}',
        ${FIX_DIMS},
        '[0.1,0.2,0.3]'::halfvec
      );
    RAISE EXCEPTION 'expected short_term insert to fail';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'short_term_reject=1';
    WHEN OTHERS THEN
      IF SQLERRM ~* 'check' OR SQLERRM ~* 'memory_type' THEN
        RAISE NOTICE 'short_term_reject=1';
      ELSE
        RAISE;
      END IF;
  END;
END \$\$;
SELECT 'short_term_reject=1';

-- Allowed type still works.
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
SELECT 'long_term_ok=' || count(*)::text FROM memory_embeddings WHERE memory_type = 'long_term';
COMMIT;

-- GUCs present on ≥0.8 (iterative_scan).
SHOW hnsw.iterative_scan;
SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true);
SELECT set_config('hnsw.ef_search', '40', true);
SELECT set_config('hnsw.max_scan_tuples', '20000', true);
SELECT 'guc_ok=1';
EOF
)

FULL_SQL="$(cat "$SQL")
${VERIFY_SQL}"

echo "== 2 apply DDL + short_term reject / undim HNSW via pooler =="
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

printf '%s\n' "$OUT" | grep -Eq '^ext_ver=0\.(8|9|[1-9][0-9])' \
  || fail "pgvector must be ≥ 0.8 (got ext_ver line):
$OUT"
printf '%s\n' "$OUT" | grep -qx 'undim_hnsw_fail=1' || fail "undimensioned HNSW must fail:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'short_term_reject=1' || fail "short_term INSERT must be rejected:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'long_term_ok=1' || fail "long_term INSERT should succeed:
$OUT"
printf '%s\n' "$OUT" | grep -qx 'guc_ok=1' || fail "iterative_scan / ef_search GUCs missing:
$OUT"

ok "short_term refuse + undim HNSW fail + pgvector≥0.8 GUCs via pooler"
echo "smoke-memory-embed-guard: PASS"
