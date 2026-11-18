'use strict';

const assert = require('assert');
const { withTenantTx } = require('./tenant-tx');

async function main() {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };

  const out = await withTenantTx(client, 'tenant-a', async (c) => {
    await c.query('INSERT INTO memory_items /* stub */ SELECT 1');
    return { ok: true };
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls[0].text, 'BEGIN');
  assert.ok(
    /set_config\('app\.tenant_id',\s*\$1,\s*true\)/.test(calls[1].text),
    'expected set_config(..., true) before work'
  );
  assert.deepStrictEqual(calls[1].params, ['tenant-a']);
  assert.ok(calls[2].text.includes('INSERT'), 'work must run after set_config');
  assert.strictEqual(calls[3].text, 'COMMIT');

  for (const c of calls) {
    assert.ok(!/,\s*false\s*\)/.test(c.text), 'must never set_config(..., false)');
    assert.ok(!/SET\s+app\.tenant_id/i.test(c.text), 'must never SET app.tenant_id');
  }

  let rejected = false;
  try {
    await withTenantTx(client, '', async () => null);
  } catch (e) {
    rejected = e.message === 'tenant_id_required';
  }
  assert.ok(rejected, 'empty tenant_id must fail');

  console.log('OK: tenant-tx set_config(..., true) before work; never false');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
