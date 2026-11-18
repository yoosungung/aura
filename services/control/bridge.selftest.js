'use strict';

const assert = require('assert');
const {
  SUBJECT,
  QUEUE_GROUP,
  handleResolve,
  STUB_SOURCE,
  STUB_USER,
} = require('./bridge');

async function main() {
  assert.strictEqual(SUBJECT, 'aura.rpc.control.resolve');
  assert.strictEqual(QUEUE_GROUP, 'aura-control-resolve');

  const bad = await handleResolve({ kind: 'agent' });
  assert.strictEqual(bad.type, 'control.resolve.error');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.subject, SUBJECT);

  const mismatch = await handleResolve({
    tenant_id: '11111111-1111-1111-1111-111111111111',
    kind: 'agent',
    name: 'demo',
    version: '1.0.0',
    principal: { id: 'user-1', tenant_id: 'other' },
  });
  assert.strictEqual(mismatch.error, 'tenant_mismatch');

  const stub = await handleResolve({
    tenant_id: STUB_SOURCE.tenant_id,
    kind: STUB_SOURCE.kind,
    name: STUB_SOURCE.name,
    version: STUB_SOURCE.version,
    principal: { id: STUB_USER.principal_id, tenant_id: STUB_SOURCE.tenant_id },
  });
  assert.strictEqual(stub.type, 'control.resolve.done');
  assert.strictEqual(stub.ok, true);
  assert.strictEqual(stub.mode, 'stub');
  assert.strictEqual(stub.deploy_class, 'sync');
  assert.strictEqual(stub.subject, SUBJECT);
  assert.strictEqual(stub.secrets_ref, STUB_USER.secrets_ref);
  assert.deepStrictEqual(stub.cfg, {
    timeout_seconds: 30,
    llm: { model: 'b', temp: 0.2 },
    flag: true,
  });
  assert.ok(!('secrets' in stub));

  const missing = await handleResolve({
    tenant_id: STUB_SOURCE.tenant_id,
    kind: 'mcp',
    name: 'nope',
    version: '9.9.9',
    principal: { id: 'x', tenant_id: STUB_SOURCE.tenant_id },
  });
  assert.strictEqual(missing.type, 'control.resolve.error');
  assert.strictEqual(missing.error, 'source_not_active');

  const injected = await handleResolve(
    {
      tenant_id: 't1',
      kind: 'mcp',
      name: 'tool',
      version: '2.0.0',
      principal: { id: 'p1', tenant_id: 't1' },
    },
    {
      lookup: async () => ({
        source: {
          id: 's1',
          tenant_id: 't1',
          kind: 'mcp',
          name: 'tool',
          version: '2.0.0',
          entrypoint: 'm:f',
          bundle_uri: 's3://x',
          checksum: 'sha256:ab',
          config: { a: 1 },
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        user: null,
      }),
    },
  );
  assert.strictEqual(injected.type, 'control.resolve.done');
  assert.strictEqual(injected.mode, 'injectable');
  assert.strictEqual(injected.user, null);
  assert.strictEqual(injected.secrets_ref, null);
  assert.deepStrictEqual(injected.cfg, { a: 1 });

  console.log('bridge.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
