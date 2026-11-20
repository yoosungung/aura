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
