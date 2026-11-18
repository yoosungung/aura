#!/usr/bin/env bash
# M1 static gate: production AURA_EMBEDDING_MODEL / version / dims pin (doc-only).
# Validates deploy/docs/memory-embedding-active.md. Exit 0 on PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-embedding-active.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"

grep -q 'AURA_EMBEDDING_MODEL' "$DOC" || fail "doc must name AURA_EMBEDDING_MODEL"
grep -q 'BAAI/bge-m3' "$DOC" || fail "doc must pin model BAAI/bge-m3"
grep -Eq 'AURA_EMBEDDING_VERSION.*`?1`?|version.*`1`' "$DOC" || fail "doc must pin version=1"
grep -Eq 'AURA_EMBEDDING_DIMS.*1024|dims.*1024|`1024`' "$DOC" || fail "doc must pin dims=1024"
grep -q 'BAAI/bge-m3:1' "$DOC" || fail "doc must state model_key BAAI/bge-m3:1"
grep -qi 'bge-m3-tei' "$DOC" || fail "doc must cite serving hint bge-m3-tei"
grep -Eqi 'Non-goals|본구현' "$DOC" || fail "doc must state Non-goals"
grep -qi 'memory-ttl-policy' "$DOC" || fail "doc must defer TTL to memory-ttl-policy.md"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -q 'BAAI/bge-m3' "$ROADMAP" || fail "ROADMAP decision log must mention BAAI/bge-m3"
grep -Eq '활성 임베딩|AURA_EMBEDDING' "$ROADMAP" || fail "ROADMAP must record active embedding decision"

ok "memory-embedding-active.md MODEL=BAAI/bge-m3 VERSION=1 DIMS=1024 + model_key"
echo "check-memory-embedding-active: PASS"
