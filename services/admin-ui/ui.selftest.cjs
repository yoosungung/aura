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
assert.ok(/btn-presign|Bundles|presign/.test(
  fs.readFileSync(path.join(root, 'src/features/bundles/bundles-page.tsx'), 'utf8')
), 'bundle flow controls');
assert.ok(/secrets_ref/.test(overlays), 'secrets_ref field');
assert.ok(!/secret_value|plaintext|api_key/.test(overlays), 'no plaintext secret inputs');
assert.ok(!/type="password"[^>]*id="ov-/.test(overlays), 'no overlay secret value password field');
assert.ok(/ov-source/.test(overlays) && /select/.test(overlays), 'overlay source is select');
assert.ok(!/source_meta id/.test(overlays), 'no raw source_meta id label');
assert.ok(/formatSourceLabel|Sources/.test(overlays) || /select source/.test(overlays), 'source picker labels');
assert.ok(/fillFromRow|Click a row/.test(overlays), 'overlay row fills form');
assert.ok(/searchParams|source=/.test(overlays), 'overlay reads ?source=');
assert.ok(/ConfigEntriesEditor/.test(overlays), 'overlay uses config entries editor');
assert.ok(!/Config JSON/.test(overlays), 'overlay has no raw Config JSON label');

const sourcesPage = fs.readFileSync(
  path.join(root, 'src/features/sources/sources-page.tsx'),
  'utf8'
);
assert.ok(/\/overlays\?source=/.test(sourcesPage), 'sources link to overlays');

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
