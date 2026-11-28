#!/usr/bin/env bash
# M6 static gate: Admin UI MVP · control admin HTTP · control_audit · pooler-lookup.
# Exit 0 on PASS. live Garage/Pooler CI not required (injectable).
# M6.1 React sources replace vanilla app.js — see also check-admin-ui.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/admin-ui-mvp.md"
RESOLVE_DOC="$ROOT/deploy/docs/svc-control-resolve.md"
SQL="$ROOT/deploy/sql/control_meta.sql"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
AGENTS="$ROOT/AGENTS.md"
DESIGN_CTRL="$ROOT/services/control/DESIGN.md"
DESIGN_UI="$ROOT/services/admin-ui/DESIGN.md"
K8S="$ROOT/deploy/k8s/control-admin"
CTRL="$ROOT/services/control"
UI="$ROOT/services/admin-ui"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$RESOLVE_DOC" ]] || fail "missing $RESOLVE_DOC"
[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DESIGN_CTRL" ]] || fail "missing $DESIGN_CTRL"
[[ -f "$DESIGN_UI" ]] || fail "missing $DESIGN_UI"
[[ -d "$K8S" ]] || fail "missing $K8S"
[[ -f "$CTRL/Dockerfile" ]] || fail "missing control Dockerfile"
[[ -f "$CTRL/src/lib.rs" ]] || fail "missing control Rust lib"
[[ ! -d "$CTRL/js" ]] || fail "control/js must be removed"
[[ -f "$UI/index.html" ]] || fail "missing admin-ui index.html"
[[ -f "$UI/src/main.tsx" || -f "$UI/src/lib/api.ts" ]] || fail "missing admin-ui React sources"

# Doc contracts
grep -Eqi 'pending.*active|activate' "$DOC" || fail "doc must lock activate status machine"
grep -Eqi 'checksum|sha256|Garage|GetObject' "$DOC" || fail "doc must lock server-side checksum"
grep -Eqi 'tenant_meta|DISTINCT|AURA_ADMIN_TENANT_IDS' "$DOC" || fail "doc must lock tenant picker source"
grep -Eqi 'control_audit' "$DOC" || fail "doc must name control_audit"
grep -Eq 'POST.*/v1/sources|/activate|/overlays' "$DOC" || fail "doc must list admin HTTP paths"
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'Chat UI|tenants/ACL|과금' "$DOC" || fail "doc must exclude Chat UI / tenants ACL / billing"

# Resolve doc path sync (discarded routes gone)
grep -Eq 'POST.*/v1/sources|/activate|overlays' "$RESOLVE_DOC" \
  || fail "svc-control-resolve.md must list M6 admin paths"
if grep -E '^\| `PUT` \| `/v1/sources/\{kind\}' "$RESOLVE_DOC"; then
  fail "svc-control-resolve.md must not list discarded PUT …/{version} as active"
fi
if grep -E '^\| `PUT` \| `/v1/sources/.*/user-meta' "$RESOLVE_DOC"; then
  fail "svc-control-resolve.md must not list user-meta as active path"
fi
grep -Eqi '폐기|discard' "$RESOLVE_DOC" || fail "svc-control-resolve.md must mark old paths as discarded"

# DDL
grep -q 'CREATE TABLE control_audit' "$SQL" || fail "SQL must create control_audit"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "SQL must FORCE RLS"
grep -q "current_setting('app.tenant_id'" "$SQL" || fail "RLS must use app.tenant_id"

# ARCHITECTURE / ROADMAP / AGENTS
grep -Eqi 'aura-control-admin|admin-ui-mvp|admin-ui\.md|control_audit' "$ARCH" \
  || fail "ARCHITECTURE must cite control-admin / admin-ui / control_audit"
grep -Eqi 'admin-ui-mvp|admin-ui\.md|관리 UI|M6' "$ROADMAP" || fail "ROADMAP must cite Admin UI M6"
grep -Eqi 'admin-ui-mvp|admin-ui' "$AGENTS" || fail "AGENTS must list admin-ui docs/path"

# DESIGN
grep -Eqi 'control_audit|aura-control-admin|StubPooler|resolve_with_pooler' "$DESIGN_CTRL" \
  || fail "control DESIGN must name audit / admin / pooler resolve"
grep -q '## Commands' "$DESIGN_CTRL" || fail "control DESIGN Commands"
grep -q '## Commands' "$DESIGN_UI" || fail "admin-ui DESIGN Commands"
grep -Eqi 'Non-goals' "$DESIGN_UI" || fail "admin-ui DESIGN Non-goals"

# K8s
DEP="$K8S/deployment.yaml"
grep -q 'aura-control-admin' "$DEP" || fail "k8s must name aura-control-admin"
grep -Eq 'replicas:[[:space:]]*[1-9]' "$DEP" || fail "control-admin replicas ≥ 1"
grep -q 'namespace: aura' "$DEP" || fail "control-admin ns aura"
grep -q 'image: aura/control-admin:local' "$DEP" || fail "control-admin image must be aura/control-admin:local"
[[ -f "$CTRL/Dockerfile" ]] || fail "missing control-admin Dockerfile"
grep -q 'dev.orbstack.icon=' "$CTRL/Dockerfile" || fail "control-admin image must set dev.orbstack.icon"
if grep -Eq 'COPY .*aura-logo\.jpg' "$CTRL/Dockerfile"; then
  fail "control-admin image must not bake the logo file"
fi
grep -q 'aura-control-admin' "$CTRL/Dockerfile" || fail "Dockerfile must build aura-control-admin"
if grep -Eq 'aura-control-admin-app|npm install' "$DEP"; then
  fail "control-admin must not mount source ConfigMap or npm install at start"
fi
UI_DEP="$ROOT/deploy/k8s/admin-ui/deployment.yaml"
grep -q 'image: aura/admin-ui:local' "$UI_DEP" || fail "admin-ui image must be aura/admin-ui:local"
[[ -f "$UI/Dockerfile" ]] || fail "missing admin-ui Dockerfile"
[[ -f "$UI/nginx.conf" ]] || fail "missing baked nginx.conf"
if grep -Eq 'aura-admin-ui-dist|aura-admin-ui-nginx' "$UI_DEP"; then
  fail "admin-ui must not mount dist/nginx ConfigMaps"
fi
if grep -Eqi 'MessageQueueTrigger|mqtype|ScaledObject' "$K8S"/*.yaml 2>/dev/null; then
  fail "control-admin must not use MQT/ScaledObject"
fi

# Code invariants
grep -q 'SET_TENANT_GUC_SQL' "$CTRL/src/lib.rs" || fail "control must keep SET_TENANT_GUC_SQL"
grep -q 'resolve_with_pooler' "$CTRL/src/lib.rs" || fail "control must expose resolve_with_pooler"
grep -Eqi 'checksum|sha256|activate' "$DOC" || fail "doc must lock checksum activate"
grep -Eqi 'control_audit' "$DOC" "$DESIGN_CTRL" || fail "docs must name control_audit"
grep -Eq 'reason_required|/v1/audit|allowed_admin_paths' "$CTRL/src/lib.rs" \
  || fail "Rust control must expose admin path/audit surface"
grep -Eq 'x-aura-tenant-id' "$UI/src/lib/api.ts" || fail "admin-ui must send tenant header"
if grep -Eqi 'aura\.rpc\.control\.resolve' "$UI/src/lib/api.ts" "$UI/src"/features/*/*.tsx 2>/dev/null; then
  fail "admin-ui must not call NATS resolve"
fi

# Unit gates
(cd "$ROOT" && cargo test -p aura-control --quiet) || fail "cargo test -p aura-control failed"
node "$UI/ui.selftest.cjs" || fail "admin-ui ui.selftest failed"

ok "admin-ui-mvp docs + DDL + Rust admin + pooler-lookup + UI"
echo "check-admin-ui-mvp: PASS"
