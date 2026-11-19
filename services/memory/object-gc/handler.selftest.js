'use strict';

const assert = require('assert');
const handler = require('./handler');

function fakeClient(liveKeys) {
  const live = new Set(liveKeys || []);
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/set_config\('app\.tenant_id'/.test(sql)) {
        return { rows: [{ set_config: params[0] }] };
      }
      if (/memory_items|memory_audit|content_ref/i.test(sql)) {
        const key = params && params[2];
        return { rows: live.has(key) ? [{ hit: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

function fakeStore(objects) {
  const deleted = [];
  return {
    deleted,
    async listObjects({ prefix }) {
      return (objects || []).filter((o) => o.key.startsWith(prefix));
    },
    async deleteObject({ key }) {
      deleted.push(key);
      return { ok: true };
    },
  };
}

async function run() {
  process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';

  // delete orphan; skip live ref; skip young; skip archive prefix
  {
    const liveKey = 'tenants/t1/refs/2024/01/live';
    const orphan = 'tenants/t1/refs/2024/01/orphan';
    const client = fakeClient([liveKey]);
    const store = fakeStore([
      { key: orphan, lastModified: '2025-01-01T00:00:00.000Z' },
      { key: liveKey, lastModified: '2025-01-01T00:00:00.000Z' },
      {
        key: 'tenants/t1/refs/2026/11/young',
        lastModified: '2026-11-01T00:00:00.000Z',
      },
      {
        key: 'tenants/t1/archive/episodic/2023/10/x.parquet',
        lastModified: '2020-01-01T00:00:00.000Z',
      },
    ]);

    const res = await handler({
      pgClient: client,
      objectStore: store,
      request: {
        body: JSON.stringify({
          id: 'object-gc:t1:2026-11-19',
          tenant_id: 't1',
          payload: { now: '2026-11-19T12:00:00.000Z' },
        }),
      },
    });
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.object_gc.done');
    assert.deepStrictEqual(body.payload.deleted, [orphan]);
    assert.ok(body.payload.skipped_live.includes(liveKey));
    assert.ok(body.payload.skipped_young.includes('tenants/t1/refs/2026/11/young'));
    assert.strictEqual(store.deleted.length, 1);
    assert.strictEqual(store.deleted[0], orphan);

    // tenant GUC true
    assert.ok(
      client.calls.some(
        (c) =>
          /set_config\('app\.tenant_id'/.test(c.sql) &&
          Array.isArray(c.params) &&
          c.params[0] === 't1'
      )
    );
    // live-ref SQL uses metadata JSON path
    assert.ok(
      client.calls.some((c) => /metadata\s*#>>\s*'\{content_ref,bucket\}'/.test(c.sql))
    );
  }

  // missing tenant
  {
    const res = await handler({
      pgClient: fakeClient([]),
      objectStore: fakeStore([]),
      request: { body: JSON.stringify({ id: 'x', payload: {} }) },
    });
    assert.strictEqual(res.status, 400);
  }

  // bad pooler
  {
    process.env.AURA_DATABASE_HOST = 'aura-pg-rw.aura.svc.cluster.local';
    const res = await handler({
      pgClient: fakeClient([]),
      objectStore: fakeStore([]),
      request: {
        body: JSON.stringify({ id: 'x', tenant_id: 't', payload: {} }),
      },
    });
    assert.strictEqual(res.status, 500);
    process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';
  }

  console.log('object-gc handler.selftest: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
