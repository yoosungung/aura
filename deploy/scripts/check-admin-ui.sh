#!/usr/bin/env bash
# M6.1 gate: Admin UI React · admin-ui.md · GET /v1/audit · Vitest + build.
# Exit 0 on PASS. live Garage/Pooler CI not required (injectable).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/admin-ui.md"
MVP="$ROOT/deploy/docs/admin-ui-mvp.md"
SQL="$ROOT/deploy/sql/control_meta.sql"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
AGENTS="$ROOT/AGENTS.md"
DESIGN_CTRL="$ROOT/services/control/DESIGN.md"
DESIGN_UI="$ROOT/services/admin-ui/DESIGN.md"
CTRL="$ROOT/services/control"
UI="$ROOT/services/admin-ui"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$MVP" ]] || fail "missing $MVP (historical snapshot)"
[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$DESIGN_CTRL" ]] || fail "missing $DESIGN_CTRL"
[[ -f "$DESIGN_UI" ]] || fail "missing $DESIGN_UI"
[[ -f "$CTRL/Dockerfile" ]] || fail "missing control Dockerfile"
[[ -f "$CTRL/src/lib.rs" ]] || fail "missing control Rust lib"
[[ ! -d "$CTRL/js" ]] || fail "control/js must be removed"
[[ -f "$UI/package.json" ]] || fail "missing admin-ui package.json"
[[ -f "$UI/src/main.tsx" ]] || fail "missing admin-ui src/main.tsx"
[[ -f "$UI/src/lib/schemas.ts" ]] || fail "missing schemas.ts"
[[ -f "$UI/src/lib/api.ts" ]] || fail "missing api.ts"

# Doc contracts
grep -Eqi 'pending.*active|activate' "$DOC" || fail "doc must lock activate status machine"
grep -Eqi 'checksum|sha256|Garage|GetObject' "$DOC" || fail "doc must lock server-side checksum"
grep -Eqi 'tenant_meta|DISTINCT' "$DOC" || fail "doc must lock tenant picker source"
if grep -Eqi 'AURA_ADMIN_TENANT_IDS' "$DOC"; then
  fail "AURA_ADMIN_TENANT_IDS removed — use tenant_meta"
fi
grep -Eqi 'control_audit' "$DOC" || fail "doc must name control_audit"
grep -Eq 'GET.*/v1/audit|/v1/audit' "$DOC" || fail "doc must list GET /v1/audit"
grep -Eq 'POST.*/v1/sources|/activate|/overlays' "$DOC" || fail "doc must list admin HTTP paths"
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'Chat UI|tenants/ACL|과금' "$DOC" || fail "doc must exclude Chat UI / tenants ACL / billing"
grep -Eqi 'PostgreSQL|PG' "$DOC" || fail "doc must lock PG as SoR"
grep -Eqi 'NATS.*KV|JetStream KV|quota' "$DOC" || fail "doc must discuss NATS KV quota"
grep -Eqi 'Gateway만|Gateway only|aura.rpc.gateway.quota' "$DOC" || fail "doc must lock Phase2 quota via Gateway"
grep -Eqi 'React|Vite|Tailwind|Zod|TanStack|Zustand' "$DOC" || fail "doc must lock React stack"

# DDL
grep -q 'CREATE TABLE control_audit' "$SQL" || fail "SQL must create control_audit"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "SQL must FORCE RLS"

# ARCHITECTURE / ROADMAP / AGENTS
grep -Eqi 'aura-control-admin|admin-ui\.md|control_audit' "$ARCH" \
  || fail "ARCHITECTURE must cite control-admin / admin-ui / control_audit"
grep -Eqi 'admin-ui\.md|M6\.1|관리 UI' "$ROADMAP" || fail "ROADMAP must cite Admin UI M6.1"
grep -Eqi 'admin-ui\.md|admin-ui' "$AGENTS" || fail "AGENTS must list admin-ui docs/path"

# DESIGN
grep -Eqi 'pooler-lookup|control_audit|GET /v1/audit|/v1/audit|aura-control-admin' "$DESIGN_CTRL" \
  || fail "control DESIGN must name audit / Rust admin"
grep -q '## Commands' "$DESIGN_CTRL" || fail "control DESIGN Commands"
grep -q '## Commands' "$DESIGN_UI" || fail "admin-ui DESIGN Commands"
grep -Eqi 'Non-goals' "$DESIGN_UI" || fail "admin-ui DESIGN Non-goals"
grep -Eqi 'React|Vite|Zod|TanStack|Zustand' "$DESIGN_UI" || fail "admin-ui DESIGN must name React stack"
grep -Eq 'aura/control-admin:local' "$DESIGN_CTRL" || fail "control DESIGN must name baked image"
grep -Eq 'aura/admin-ui:local' "$DESIGN_UI" || fail "admin-ui DESIGN must name baked image"

# Images (no source/dist ConfigMap)
DEP="$ROOT/deploy/k8s/control-admin/deployment.yaml"
UI_DEP="$ROOT/deploy/k8s/admin-ui/deployment.yaml"
APPLY="$ROOT/deploy/scripts/apply-admin-ui.sh"
[[ -f "$CTRL/Dockerfile" ]] || fail "missing control-admin Dockerfile"
[[ -f "$UI/Dockerfile" ]] || fail "missing admin-ui Dockerfile"
[[ -f "$UI/nginx.conf" ]] || fail "missing admin-ui nginx.conf"
grep -q 'aura-control-admin' "$CTRL/Dockerfile" || fail "control image must run aura-control-admin"
grep -q 'dev.orbstack.icon=' "$CTRL/Dockerfile" || fail "control-admin image must set dev.orbstack.icon"
if grep -Eq 'COPY .*aura-logo\.jpg' "$CTRL/Dockerfile"; then
  fail "control-admin image must not bake the logo file"
fi
grep -q 'listen 8080' "$UI/nginx.conf" || fail "nginx.conf must listen 8080"
[[ -f "$UI/public/aura-logo.jpg" ]] || fail "missing public/aura-logo.jpg"
grep -q 'dev.orbstack.icon=' "$UI/Dockerfile" || fail "admin-ui image must set dev.orbstack.icon"
grep -q 'aura-logo.jpg' "$UI/Dockerfile" || fail "admin-ui image build must require aura-logo.jpg"
grep -q 'aura-logo.jpg' "$UI/index.html" || fail "favicon must use aura-logo.jpg"
grep -q 'aura-logo.jpg' "$UI/src/app/shell.tsx" || fail "header must use aura-logo.jpg"
grep -q 'image: aura/control-admin:local' "$DEP" || fail "control-admin image must be aura/control-admin:local"
grep -q 'image: aura/admin-ui:local' "$UI_DEP" || fail "admin-ui image must be aura/admin-ui:local"
if grep -Eq 'aura-control-admin-app|npm install' "$DEP"; then
  fail "control-admin must not mount source ConfigMap or npm install at start"
fi
if grep -Eq 'aura-admin-ui-dist|aura-admin-ui-nginx' "$UI_DEP"; then
  fail "admin-ui must not mount dist/nginx ConfigMaps"
fi
if grep -Eq 'create configmap aura-control-admin-app|create configmap aura-admin-ui-dist' "$APPLY"; then
  fail "apply-admin-ui.sh must not create code ConfigMaps"
fi

# Code invariants (admin HTTP server = Rust; checksum activate contract stays in docs)
grep -Eq '/v1/audit|allowed_admin_paths' "$CTRL/src/lib.rs" \
  || fail "Rust control must expose /v1/audit paths"
grep -Eqi 'checksum|sha256|activate' "$DOC" || fail "doc must lock checksum activate"
grep -Eqi 'control_audit' "$DOC" "$DESIGN_CTRL" || fail "docs must name control_audit"
grep -Eq 'x-aura-tenant-id' "$UI/src/lib/api.ts" || fail "admin-ui must send tenant header"
if grep -Eqi 'aura\.rpc\.control\.resolve' "$UI/src/lib/api.ts" "$UI/src"/features/*/*.tsx 2>/dev/null; then
  fail "admin-ui must not call NATS resolve"
fi
grep -Eq 'runtime_in_config_forbidden' "$UI/src/lib/schemas.ts" \
  || fail "schemas must forbid runtime in config"

# Unit + build
(cd "$ROOT" && cargo test -p aura-control --quiet) || fail "cargo test -p aura-control failed"
node "$UI/ui.selftest.cjs" || fail "admin-ui ui.selftest failed"
(
  cd "$UI"
  npm test || fail "admin-ui vitest failed"
  npm run build || fail "admin-ui build failed"
  [[ -f dist/aura-logo.jpg ]] || fail "vite build must copy aura-logo.jpg into dist"
  [[ -f dist/scaffolds/agent-nodejs.zip ]] || fail "vite build must emit scaffold zips"
  [[ -f dist/scaffolds/agent-nodejs/package.json ]] || fail "scaffold mirror must include package.json"
)

ok "admin-ui docs + audit API + React SPA + vitest + build"
echo "check-admin-ui: PASS"
