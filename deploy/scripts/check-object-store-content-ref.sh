#!/usr/bin/env bash
# M2 static gate: Object Store product + content_ref schema/ACL (doc + ARCHITECTURE).
# Exit 0 on PASS. Ticket a050691d. Non-goal: live bucket provision · orphan GC impl (next child/M4).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/object-store-content-ref.md"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"

# Product name locked (V2.1 → RustFS 단독 · Garage 제거).
grep -qi 'RustFS' "$DOC" || fail "doc must name RustFS as Object Store product"
grep -Eqi '비채택.*Garage|Garage.*제거|Garage.*비채택' "$DOC" \
  || fail "doc must mark Garage as rejected/removed"
grep -Eqi 'S3|SigV4|s3-compatible|S3-compatible' "$DOC" \
  || fail "doc must lock S3-compatible / SigV4 client contract"
grep -qi 'Non-goals\|본구현\|보류\|provision' "$DOC" \
  || fail "doc must state Non-goals / live provision deferred"

# 256KB → content_ref only.
grep -qE '256\s*\*?\*?KB|256KB|262144' "$DOC" \
  || fail "doc must state 256KB payload ceiling"
grep -Eqi 'content_ref' "$DOC" || fail "doc must define content_ref"
grep -Eqi '초과|exceed|> ?256|ref-only|원문.*금지|payload.*원문' "$DOC" \
  || fail "doc must require content_ref-only above 256KB (no inline body)"

# Schema fields.
grep -Eqi 'bucket' "$DOC" || fail "doc must name bucket"
grep -Eqi 'tenants/\{tenant_id\}|tenants/\$\{tenant_id\}|tenants/\{tenant' "$DOC" \
  || fail "doc must lock tenant key prefix tenants/{tenant_id}/…"
grep -Eqi 'scheme|s3://' "$DOC" || fail "doc must define scheme / s3:// form"

# Permissions / isolation.
grep -Eqi 'Egress|NetworkPolicy|allow' "$DOC" \
  || fail "doc must require Egress allowlist to object store"
grep -Eqi '암호화|encrypt|crypto|AES|kid' "$DOC" \
  || fail "doc must mention object encryption / kid for crypto-shred"
grep -Eqi '공개|public|ACL.*금지|no public' "$DOC" \
  || fail "doc must ban public ACL / anonymous read"

# Bucket separation from PG Barman backup.
grep -Eqi 'aura-content|Barman|aura-pg|backup' "$DOC" \
  || fail "doc must separate content bucket from PG backup"

# M4: shared aura-content with refs/ + archive/ + bundles/ (no per-use bucket).
grep -Eq 'aura-content' "$DOC" || fail "doc must name aura-content bucket"
grep -Eq 'refs/' "$DOC" || fail "doc must lock refs/ prefix"
grep -Eq 'archive/' "$DOC" || fail "doc must lock archive/ prefix (shared bucket)"
grep -Eq 'bundles/' "$DOC" || fail "doc must lock bundles/ prefix (shared with bundle store)"
grep -Eqi '버킷 공유|동일 버킷|공유 버킷|shared bucket|single bucket' "$DOC" \
  || fail "doc must state shared single aura-content bucket across refs/archive/bundles"
grep -Eqi 'aura-pg|Barman' "$DOC" \
  || fail "doc must keep Barman/aura-pg non-shared"
grep -Eq 'refs/|archive/|bundles/' "$ARCH" \
  || fail "ARCHITECTURE §8 must name shared prefixes (refs/archive/bundles)"

# ARCHITECTURE + ROADMAP pointers.
grep -Eq 'object-store-content-ref\.md' "$ARCH" \
  || fail "ARCHITECTURE must link deploy/docs/object-store-content-ref.md"
grep -q '256' "$ARCH" || fail "ARCHITECTURE must keep 256KB ceiling"
grep -Eqi 'RustFS|object-store-content-ref|object-store-rustfs' "$ROADMAP" \
  || fail "ROADMAP decision log must cite RustFS or object-store doc"
grep -Eqi 'bundles/|번들 스토어|공유 버킷|aura-content' "$ROADMAP" \
  || fail "ROADMAP must seal shared-bucket / bundles path contract"
grep -Eqi 'content_ref|Object Store|object.store' "$DESIGN" \
  || fail "services/memory/DESIGN.md must point at Object Store / content_ref"

ok "object-store-content-ref.md RustFS product + schema + 256KB + shared bucket/prefixes + ARCHITECTURE link"
echo "check-object-store-content-ref: PASS"
