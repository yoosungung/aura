'use strict';

const assert = require('assert');
const handler = require('./handler');

async function main() {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };

  const res = await handler({
    request: {
      body: JSON.stringify({
        id: 'evt-1',
        type: 'memory.candidates',
        tenant_id: 'tenant-a',
        payload: { memory_type: 'short_term', content: 'hi' },
      }),
    },
    pgClient: client,
  });

  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.type, 'memory.stored');
  assert.strictEqual(body.tenant_id, 'tenant-a');
  assert.strictEqual(calls[0].text, 'BEGIN');
  assert.ok(/set_config\('app\.tenant_id',\s*\$1,\s*true\)/.test(calls[1].text));
  assert.deepStrictEqual(calls[1].params, ['tenant-a']);
  assert.strictEqual(calls[calls.length - 1].text, 'COMMIT');

  assert.strictEqual(handler.poolerHostOk('aura-pg-pooler.aura.svc.cluster.local'), true);
  assert.strictEqual(handler.poolerHostOk('aura-pg-rw.aura.svc.cluster.local'), false);

  const bad = await handler({
    request: { body: JSON.stringify({ id: 'x' }) },
    pgClient: client,
  });
  assert.strictEqual(bad.status, 400);

  console.log('OK: handler storeOnce via withTenantTx set_config(..., true)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
