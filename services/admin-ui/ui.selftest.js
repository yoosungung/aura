'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');

assert.ok(/Aura/.test(html), 'brand Aura in header');
assert.ok(/tenant-banner|active-tenant/.test(html), 'tenant banner required');
assert.ok(/btn-presign|btn-create-source|btn-activate/.test(html), 'bundle flow controls');
assert.ok(/secrets_ref/.test(html), 'secrets_ref field');
assert.ok(!/type="password"[^>]*id="ov-/.test(html), 'no overlay secret value password field');
assert.ok(!/api_key|secret_value|plaintext/.test(html), 'no plaintext secret inputs');

assert.ok(/x-aura-tenant-id/i.test(app), 'app must send X-Aura-Tenant-Id');
assert.ok(/\/v1\/tenants/.test(app), 'app loads tenants');
assert.ok(/\/v1\/sources/.test(app), 'app calls sources');
assert.ok(/\/activate/.test(app), 'app activate');
assert.ok(!/aura\.rpc\.control\.resolve/.test(app), 'UI must not call control.resolve subject');
assert.ok(!/\bnats\.connect\b|\bNATS_URL\b/.test(app), 'UI must not open NATS client');

assert.ok(/## Commands/.test(design), 'DESIGN Commands');
assert.ok(/admin-ui-mvp\.md/.test(design), 'DESIGN links admin-ui-mvp');
assert.ok(/Non-goals/i.test(design), 'DESIGN Non-goals');

console.log('admin-ui ui.selftest: PASS');
