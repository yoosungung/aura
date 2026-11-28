'use strict';

const assert = require('assert');
const { createPoolerLookup } = require('./pooler-lookup');
const { handleResolve } = require('./bridge');

function mockClient(handlers) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      for (const h of handlers) {
        if (h.match(text, params)) {
          return h.result(text, params);
        }
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

async function main() {
  assert.throws(() => createPoolerLookup(null), /client_required/);

  const tenant = '11111111-1111-1111-1111-111111111111';
  const sourceRow = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    tenant_id: tenant,
    kind: 'agent',
    name: 'demo',
    version: '1.0.0',
    entrypoint: 'main:factory',
    bundle_uri: 's3://aura-content/tenants/' + tenant + '/bundles/demo/1.0.0',
    checksum: 'sha256:abc',
    sig_uri: null,
    config: { a: 1 },
    runtime: 'nodejs',
    status: 'active',
    created_at: new Date('2026-11-20T00:00:00.000Z'),
  };
  const userRow = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    tenant_id: tenant,
    source_meta_id: sourceRow.id,
    principal_id: 'user-1',
    config: { b: 2 },
    secrets_ref: 'k8s:secret/x',
    updated_at: new Date('2026-11-20T01:00:00.000Z'),
  };

  const client = mockClient([
    {
      match: (t) => t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK',
      result: () => ({ rows: [] }),
    },
    {
      match: (t) => /set_config\('app\.tenant_id'/.test(t),
      result: (_t, p) => ({ rows: [{ set_config: p[0] }] }),
    },
    {
      match: (t) => /FROM source_meta/.test(t),
      result: () => ({ rows: [sourceRow] }),
    },
    {
      match: (t) => /FROM user_meta/.test(t),
      result: () => ({ rows: [userRow] }),
    },
  ]);

  const lookup = createPoolerLookup(client);
  const rows = await lookup({
    tenant_id: tenant,
    kind: 'agent',
    name: 'demo',
    version: '1.0.0',
    principal: { id: 'user-1', tenant_id: tenant },
  });
  assert.strictEqual(rows.source.status, 'active');
  assert.strictEqual(rows.user.principal_id, 'user-1');
  assert.ok(client.calls.some((c) => /set_config\('app\.tenant_id'/.test(c.text)));
  assert.ok(client.calls.some((c) => /status = 'active'/.test(c.text)));

  const resolved = await handleResolve(
    {
      tenant_id: tenant,
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      principal: { id: 'user-1', tenant_id: tenant },
    },
    { lookup }
  );
  assert.strictEqual(resolved.type, 'control.resolve.done');
  assert.strictEqual(resolved.mode, 'injectable');
  assert.strictEqual(resolved.source.name, 'demo');
  assert.strictEqual(resolved.secrets_ref, 'k8s:secret/x');

  const emptyClient = mockClient([
    {
      match: (t) => t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK',
      result: () => ({ rows: [] }),
    },
    {
      match: (t) => /set_config/.test(t),
      result: () => ({ rows: [] }),
    },
    {
      match: (t) => /FROM source_meta/.test(t),
      result: () => ({ rows: [] }),
    },
  ]);
  const miss = await createPoolerLookup(emptyClient)({
    tenant_id: tenant,
    kind: 'agent',
    name: 'nope',
    version: '9.9.9',
    principal: { id: 'x', tenant_id: tenant },
  });
  assert.strictEqual(miss.source, null);

  console.log('pooler-lookup.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
