#!/usr/bin/env bash
# M1 static gate: memory_embeddings LIST(model_key) + halfvec HNSW shape + generation-swap DESIGN.
# Exit 0 on PASS. Ticket 0d7a4200. No production model dims invented here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/memory_embeddings.sql"
DOC="$ROOT/deploy/docs/memory-embeddings-generation.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DOC" ]] || fail "missing $DOC"

sql_flat="$(tr '\n' ' ' <"$SQL" | tr -s ' ')"

printf '%s\n' "$sql_flat" | grep -Eq 'PARTITION BY LIST \(model_key\)' \
  || fail "parent must PARTITION BY LIST (model_key)"
printf '%s\n' "$sql_flat" | grep -Eq 'embedding[[:space:]]+halfvec[[:space:]]+NOT NULL' \
  || fail "parent embedding must be undimensioned halfvec"
printf '%s\n' "$sql_flat" | grep -Eq "CHECK \(model_key = model \|\| ':' \|\| version\)" \
  || fail "model_key must equal model||':'||version"
printf '%s\n' "$sql_flat" | grep -Eq "CHECK \(memory_type IN \('episodic', 'long_term', 'semantic'\)\)" \
  || fail "short_term embed must be forbidden via memory_type CHECK"
printf '%s\n' "$sql_flat" | grep -Eq 'FORCE ROW LEVEL SECURITY' \
  || fail "must FORCE ROW LEVEL SECURITY"
printf '%s\n' "$sql_flat" | grep -Eq "current_setting\('app\.tenant_id'" \
  || fail "RLS must use app.tenant_id GUC"
printf '%s\n' "$sql_flat" | grep -Eq 'CREATE EXTENSION IF NOT EXISTS vector' \
  || fail "vector extension required"

# Forbidden: parent-level undimensioned HNSW; vector-typed HNSW path.
if printf '%s\n' "$sql_flat" | grep -Eqi 'USING hnsw[[:space:]]*\([[:space:]]*embedding[[:space:]]*\)'; then
  fail "parent/direct hnsw(embedding) forbidden — use halfvec(N) expression on partitions"
fi
if printf '%s\n' "$sql_flat" | grep -Eqi 'embedding[[:space:]]+vector[[:space:]]'; then
  fail "vector-typed embedding column forbidden — halfvec only"
fi

# DESIGN: generation swap ATTACH → switch → DETACH + Non-goals / fixture vs prod.
grep -qi 'ATTACH' "$DOC" || fail "doc must describe ATTACH"
grep -qi 'DETACH' "$DOC" || fail "doc must describe DETACH"
grep -Eqi 'switch|전환|active.*model_key' "$DOC" || fail "doc must describe active model_key switch"
grep -qi 'halfvec' "$DOC" || fail "doc must mention halfvec(N) HNSW"
grep -qi 'Non-goals\|본구현\|fixture' "$DOC" || fail "doc must state Non-goals / fixture vs prod"
grep -Eqi 'AURA_EMBEDDING|생산|production|실값' "$DOC" || fail "doc must defer production model dims"

ok "memory_embeddings LIST(model_key) + generation-swap DESIGN"
echo "check-memory-embeddings: PASS"
