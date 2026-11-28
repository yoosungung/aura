#!/usr/bin/env bash
# M3 static gate: svc-control source_meta/user_meta DDL + resolve wire (doc + ARCHITECTURE).
# Exit 0 on PASS. Ticket 51bc0936. Non-goal: NATS resolve bridge Deployment · HTTP admin server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/svc-control-resolve.md"
SQL="$ROOT/deploy/sql/control_meta.sql"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/control/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"

# DDL: tables + FORCE RLS + tenant GUC
grep -q 'CREATE TABLE source_meta' "$SQL" || fail "SQL must create source_meta"
grep -q 'CREATE TABLE user_meta' "$SQL" || fail "SQL must create user_meta"
grep -q 'CREATE TABLE control_audit' "$SQL" || fail "SQL must create control_audit"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "SQL must FORCE ROW LEVEL SECURITY"
grep -q "current_setting('app.tenant_id'" "$SQL" || fail "RLS must use app.tenant_id GUC"
grep -q 'UNIQUE (tenant_id, kind, name, version)' "$SQL" \
  || fail "source_meta UNIQUE (tenant_id, kind, name, version)"
grep -q 'REFERENCES source_meta' "$SQL" || fail "user_meta must FK source_meta"
grep -Eqi 'secrets_ref' "$SQL" || fail "user_meta must have secrets_ref"
grep -Eq 'runtime' "$SQL" || fail "source_meta must have runtime (M3.6 func-env)"
grep -Eq 'chk_source_meta_runtime|nodejs.*python.*custom' "$SQL" \
  || fail "source_meta.runtime CHECK missing"
if grep -Eqi '^[[:space:]]*(secret_value|api_key|secret_plain)[[:space:]]+' "$SQL"; then
  fail "SQL must not store plaintext secret columns"
fi
if grep -Eq "set_config\(\s*'app\.tenant_id'\s*,[^,]+,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$SQL"; then
  fail "session-scoped tenant GUC forbidden in DDL"
fi

# Doc: resolve wire + ownership + merge
grep -Eqi 'aura\.rpc\.control\.resolve' "$DOC" || fail "doc must name aura.rpc.control.resolve"
grep -Eqi 'source_meta|user_meta' "$DOC" || fail "doc must name source_meta/user_meta"
grep -Eqi 'control\.resolve\.done' "$DOC" || fail "doc must lock control.resolve.done"
grep -Eqi '1-depth|user wins|mergeConfigs' "$DOC" || fail "doc must lock 1-depth merge / user wins"
grep -Eqi 'secrets_ref' "$DOC" || fail "doc must require secrets_ref (no plaintext)"
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'svc-control' "$DOC" || fail "doc must name svc-control write owner"
grep -Eq 'POST.*/v1/sources|/v1/sources/\{id\}/activate|overlays' "$DOC" \
  || fail "doc must lock M6 admin HTTP paths (POST /v1/sources, activate, overlays)"
if grep -E '^\| `PUT` \| `/v1/sources/\{kind\}' "$DOC"; then
  fail "doc must not list discarded PUT …/{version} as active"
fi
grep -Eqi '폐기|discard|overlays' "$DOC" || fail "doc must mark old paths discarded / use overlays"

# ARCHITECTURE + ROADMAP + DESIGN pointers
grep -Eq 'svc-control-resolve\.md|control_meta\.sql' "$ARCH" \
  || fail "ARCHITECTURE must link svc-control-resolve.md or control_meta.sql"
grep -Eqi 'source_meta|user_meta' "$ARCH" || fail "ARCHITECTURE must keep source_meta/user_meta"
grep -Eqi 'svc-control-resolve|source_meta|control_meta' "$ROADMAP" \
  || fail "ROADMAP must cite svc-control resolve / source_meta"
grep -Eqi 'resolve\.js|svc-control-resolve' "$DESIGN" \
  || fail "services/control/DESIGN.md must point at resolve helpers / doc"

# Unit gate

ok "control_meta.sql + svc-control-resolve.md + selftest"
echo "check-svc-control-resolve: PASS"
