'use strict';

const assert = require('assert');
const handler = require('./handler');

async function main() {
  // short_term: skip — no BEGIN / set_config / INSERT attempt
  {
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
          id: 'evt-st',
          tenant_id: 'tenant-a',
          payload: { memory_type: 'short_term', item_id: 'item-1', content: 'session note' },
        }),
      },
      pgClient: client,
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.embedded');
    assert.strictEqual(body.payload.status, 'skipped_short_term');
    assert.strictEqual(body.payload.memory_type, 'short_term');
    assert.strictEqual(calls.length, 0, 'short_term must not touch PG');
  }

  // episodic: withTenantTx + active model_key stub (HNSW path)
  {
    const calls = [];
    const client = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    process.env.AURA_EMBEDDING_MODEL = 'BAAI/bge-m3';
    process.env.AURA_EMBEDDING_VERSION = '1';
    process.env.AURA_EMBEDDING_DIMS = '1024';

    const res = await handler({
      request: {
        body: JSON.stringify({
          id: 'evt-ep',
          tenant_id: 'tenant-b',
          payload: { memory_type: 'episodic', item_id: 'item-2', content: 'event text' },
        }),
      },
      pgClient: client,
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.embedded');
    assert.strictEqual(body.payload.status, 'accepted_stub');
    assert.strictEqual(body.payload.model_key, 'BAAI/bge-m3:1');
    assert.strictEqual(body.payload.dims, 1024);
    assert.strictEqual(body.payload.memory_type, 'episodic');
    assert.strictEqual(body.payload.indexes.hnsw, true);
    assert.strictEqual(body.payload.indexes.bm25, true);
    assert.strictEqual(calls[0].text, 'BEGIN');
    assert.ok(/set_config\('app\.tenant_id',\s*\$1,\s*true\)/.test(calls[1].text));
    assert.deepStrictEqual(calls[1].params, ['tenant-b']);
    assert.ok(/aura\.tasks\.memory\.embed/.test(calls[2].text));
    assert.strictEqual(calls[calls.length - 1].text, 'COMMIT');
  }

  for (const mt of ['long_term', 'semantic']) {
    const res = await handler({
      request: {
        body: JSON.stringify({
          id: `evt-${mt}`,
          tenant_id: 't',
          payload: { memory_type: mt, item_id: 'i', content: 'x' },
        }),
      },
      pgClient: { async query() { return { rows: [] }; } },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.payload.memory_type, mt);
    assert.strictEqual(body.payload.status, 'accepted_stub');
  }

  assert.strictEqual(handler.poolerHostOk('aura-pg-pooler.aura.svc.cluster.local'), true);
  assert.strictEqual(handler.poolerHostOk('aura-pg-rw.aura.svc.cluster.local'), false);
  assert.strictEqual(handler.isEmbeddableType('short_term'), false);
  assert.strictEqual(handler.isEmbeddableType('episodic'), true);

  const badType = await handler({
    request: {
      body: JSON.stringify({
        id: 'evt-bad',
        tenant_id: 't',
        payload: { memory_type: 'unknown', content: 'x' },
      }),
    },
  });
  assert.strictEqual(badType.status, 400);

  const missing = await handler({
    request: { body: JSON.stringify({ id: 'x' }) },
  });
  assert.strictEqual(missing.status, 400);

  console.log('OK: embed short_term skip + embeddable withTenantTx set_config(..., true)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
