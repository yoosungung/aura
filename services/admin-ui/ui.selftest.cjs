'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const api = fs.readFileSync(path.join(root, 'src/lib/api.ts'), 'utf8');
const schemas = fs.readFileSync(path.join(root, 'src/lib/schemas.ts'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'src/app/shell.tsx'), 'utf8');
const overlays = fs.readFileSync(
  path.join(root, 'src/features/overlays/overlays-page.tsx'),
  'utf8'
);

assert.ok(/Aura Admin/.test(shell), 'brand Aura in shell');
assert.ok(/active-tenant|tenant-banner/.test(shell), 'tenant banner required');
assert.ok(/header-tenant-select/.test(shell), 'header tenant switcher');
assert.ok(/ToastHost/.test(shell), 'toast host in shell');
assert.ok(/queryKey:\s*\['tenants'\]/.test(shell) || /enabled: !!bearer/.test(shell), 'tenants auto-fetch');
assert.ok(/btn-presign|Bundles|presign/.test(
  fs.readFileSync(path.join(root, 'src/features/bundles/bundles-page.tsx'), 'utf8')
), 'bundle flow controls');
assert.ok(/secrets_ref/.test(overlays), 'secrets_ref field');
assert.ok(!/secret_value|plaintext|api_key/.test(overlays), 'no plaintext secret inputs');
assert.ok(!/type="password"[^>]*id="ov-/.test(overlays), 'no overlay secret value password field');
assert.ok(/ov-source/.test(overlays) && /select/.test(overlays), 'overlay source is select');
assert.ok(!/source_meta id/.test(overlays), 'no raw source_meta id label');
assert.ok(/formatSourceLabel|Sources/.test(overlays) || /select source/.test(overlays), 'source picker labels');
assert.ok(/Drawer|drawer/.test(overlays), 'overlay edit uses drawer');
assert.ok(/openEdit|New overlay|Edit overlay/.test(overlays), 'overlay list + edit/create');
assert.ok(/searchParams|source=/.test(overlays), 'overlay reads ?source=');
assert.ok(/ConfigEntriesEditor/.test(overlays), 'overlay uses config entries editor');
assert.ok(!/Config JSON/.test(overlays), 'overlay has no raw Config JSON label');
assert.ok(/ConfirmDialog/.test(overlays), 'overlay delete uses ConfirmDialog');
assert.ok(!/id="ov-reason"/.test(overlays), 'no always-visible overlay reason field');

const sourcesPage = fs.readFileSync(
  path.join(root, 'src/features/sources/sources-page.tsx'),
  'utf8'
);
assert.ok(/\/overlays\?source=/.test(sourcesPage), 'sources link to overlays');
assert.ok(/btn-create-source[\s\S]*to="\/bundles"|to="\/bundles"[\s\S]*Create/.test(sourcesPage), 'sources Create → Bundles');
assert.ok(/ConfirmDialog/.test(sourcesPage), 'sources activate/retire ConfirmDialog');
assert.ok(!/id="retire-reason"/.test(sourcesPage), 'no always-visible retire reason field');
assert.ok(/formatApiError/.test(sourcesPage), 'sources uses formatApiError');
assert.ok(/filter-status|statusFilter/.test(sourcesPage), 'sources status filter');
assert.ok(/Timeline|source-versions/.test(sourcesPage), 'sources version timeline');

const auditPage = fs.readFileSync(
  path.join(root, 'src/features/audit/audit-page.tsx'),
  'utf8'
);
assert.ok(/action: appliedAction|action:/.test(auditPage), 'audit sends action query');
assert.ok(/resourceLink|\/sources\?focus=|\/overlays\?source=/.test(auditPage), 'audit deep links');

const confirmDialog = fs.readFileSync(
  path.join(root, 'src/components/confirm-dialog.tsx'),
  'utf8'
);
assert.ok(/requireReason/.test(confirmDialog), 'confirm dialog supports reason');
assert.ok(/formatApiError/.test(
  fs.readFileSync(path.join(root, 'src/lib/errors.ts'), 'utf8')
), 'formatApiError helper');

const tenantsPage = fs.readFileSync(
  path.join(root, 'src/features/tenants/tenants-page.tsx'),
  'utf8'
);
assert.ok(!/btn-load-tenants/.test(tenantsPage), 'no manual Load tenants button');
assert.ok(/paste full UUID|Advanced/.test(tenantsPage), 'UUID paste is advanced');
assert.ok(/btn-create-tenant|Create tenant|display_name/.test(tenantsPage), 'tenant create');
assert.ok(/set UUID manually|customId|showCustomId/.test(tenantsPage), 'optional manual UUID');
assert.ok(/formatTenantLabel|normalizeTenantList/.test(shell), 'shell uses tenant labels');
assert.ok(/quotas/.test(shell), 'quotas nav');
assert.ok(/QuotasPage|\/v1\/quotas\//.test(
  fs.readFileSync(path.join(root, 'src/features/quotas/quotas-page.tsx'), 'utf8')
), 'quotas page');

const bundles = fs.readFileSync(
  path.join(root, 'src/features/bundles/bundles-page.tsx'),
  'utf8'
);
assert.ok(/type="file"/.test(bundles), 'bundle file picker');
assert.ok(/sha256Checksum/.test(bundles), 'client checksum from file');
assert.ok(/putBundle/.test(bundles), 'Garage PUT via putBundle');
assert.ok(/readOnly/.test(bundles), 'bundle_uri/checksum read-only');
assert.ok(/disabled=\{!file/.test(bundles), 'register blocked until file chosen');
assert.ok(/ConfigEntriesEditor/.test(bundles), 'bundles uses config entries editor');
assert.ok(!/configText/.test(bundles), 'bundles no raw configText');
assert.ok(/btn-activate-now|Activate now/.test(bundles), 'bundles Activate now CTA');
assert.ok(/Go to Sources/.test(bundles), 'bundles Go to Sources CTA');

const configEntries = fs.readFileSync(
  path.join(root, 'src/lib/config-entries.ts'),
  'utf8'
);
assert.ok(/function configFromEntries/.test(configEntries), 'configFromEntries');
assert.ok(/function entriesFromConfig/.test(configEntries), 'entriesFromConfig');

const display = fs.readFileSync(path.join(root, 'src/lib/display.ts'), 'utf8');
assert.ok(/function shortId/.test(display), 'shortId helper');
assert.ok(/function formatSourceLabel/.test(display), 'formatSourceLabel helper');
assert.ok(/표시 규칙/.test(design), 'DESIGN documents display rules');

const upload = fs.readFileSync(path.join(root, 'src/lib/bundle-upload.ts'), 'utf8');
assert.ok(/function sha256Checksum/.test(upload), 'sha256Checksum helper');
assert.ok(/function putBundle/.test(upload), 'putBundle helper');

assert.ok(/x-aura-tenant-id/i.test(api), 'app must send X-Aura-Tenant-Id');
assert.ok(/\/v1\/tenants/.test(api) || /\/v1\/tenants/.test(
  fs.readFileSync(path.join(root, 'src/features/tenants/tenants-page.tsx'), 'utf8')
), 'app loads tenants');
assert.ok(/\/v1\/sources/.test(
  fs.readFileSync(path.join(root, 'src/features/sources/sources-page.tsx'), 'utf8')
), 'app calls sources');
assert.ok(/\/activate/.test(
  fs.readFileSync(path.join(root, 'src/features/sources/sources-page.tsx'), 'utf8')
), 'app activate');
assert.ok(/\/v1\/audit/.test(
  fs.readFileSync(path.join(root, 'src/features/audit/audit-page.tsx'), 'utf8')
), 'app loads audit');
assert.ok(!/aura\.rpc\.control\.resolve/.test(api), 'UI must not call control.resolve subject');
assert.ok(!/\bnats\.connect\b|\bNATS_URL\b/.test(api), 'UI must not open NATS client');

assert.ok(/runtime_in_config_forbidden/.test(schemas), 'Zod forbids runtime in config');
assert.ok(/react/.test(pkg), 'package.json React');
assert.ok(/tailwindcss/.test(pkg), 'package.json Tailwind');
assert.ok(/zod/.test(pkg), 'package.json Zod');
assert.ok(/@tanstack\/react-query/.test(pkg), 'package.json TanStack Query');
assert.ok(/zustand/.test(pkg), 'package.json Zustand');

assert.ok(/## Commands/.test(design), 'DESIGN Commands');
assert.ok(/admin-ui\.md/.test(design), 'DESIGN links admin-ui.md');
assert.ok(/Non-goals/i.test(design), 'DESIGN Non-goals');

console.log('admin-ui ui.selftest: PASS');
