'use strict';

const assert = require('assert');
const handler = require('./handler');

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push({ sql });
      return { rows: [] };
    },
  };
}

function fakeStore() {
  const puts = [];
  const heads = [];
  return {
    puts,
    heads,
    async putObject(args) {
      puts.push(args);
      return { etag: 'etag-1', size_bytes: args.body ? args.body.length : 0 };
    },
    async headObject(args) {
      heads.push(args);
      return { exists: false };
    },
  };
}

async function run() {
  process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';

  // Cold → Put + DETACH + DROP; hot skipped
  {
    const client = fakeClient();
    const store = fakeStore();
    const res = await handler({
      pgClient: client,
      objectStore: store,
      request: {
        body: JSON.stringify({
          id: 'arch-1',
          tenant_id: 'tenant-a',
          payload: {
            now: '2026-11-19T12:00:00.000Z',
            partitions: [
              {
                name: 'memory_items_episodic_2023_10',
                upper_bound: '2023-11-01T00:00:00.000Z',
                row_count: 3,
              },
              {
                name: 'memory_items_episodic_2026_10',
                upper_bound: '2026-11-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
    });
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.archived');
    assert.strictEqual(body.payload.archived.length, 1);
    assert.strictEqual(body.payload.skipped.length, 1);
    assert.strictEqual(
      body.payload.archived[0].key,
      'tenants/tenant-a/archive/episodic/2023/10/memory_items_episodic_2023_10.parquet'
    );
    assert.strictEqual(body.payload.archived[0].bucket, 'aura-content');
    assert.strictEqual(body.payload.archived[0].row_count, 3);

    assert.strictEqual(store.puts.length, 1);
    assert.strictEqual(store.puts[0].bucket, 'aura-content');
    assert.strictEqual(store.puts[0].contentType, 'application/vnd.apache.parquet');
    assert.ok(Buffer.isBuffer(store.puts[0].body));
    assert.strictEqual(store.puts[0].body.subarray(0, 4).toString(), 'PAR1');

    const detach = client.calls.filter((c) => /DETACH PARTITION/i.test(c.sql));
    const drop = client.calls.filter((c) => /DROP TABLE/i.test(c.sql));
    assert.strictEqual(detach.length, 1);
    assert.ok(detach[0].sql.includes('memory_items_episodic_2023_10'));
    assert.strictEqual(drop.length, 1);
    assert.ok(/RESTRICT/i.test(drop[0].sql));
    assert.ok(!/CASCADE/i.test(drop[0].sql));
    assert.ok(drop[0].sql.includes('aura.tasks.memory.archive'));
    assert.ok(!client.calls.some((c) => /DELETE\s+FROM\s+memory_/i.test(c.sql || '')));
    assert.ok(
      !client.calls.some(
        (c) =>
          /DETACH|DROP/i.test(c.sql || '') &&
          (c.sql || '').includes('memory_items_episodic_2026_10')
      )
    );
  }

  // Put failure → no DETACH/DROP
  {
    const client = fakeClient();
    const res = await handler({
      pgClient: client,
      objectStore: {
        async putObject() {
          return { etag: null };
        },
      },
      request: {
        body: JSON.stringify({
          id: 'arch-2',
          tenant_id: 'tenant-a',
          payload: {
            now: '2026-11-19T12:00:00.000Z',
            partitions: [
              {
                name: 'memory_items_episodic_2023_10',
                upper_bound: '2023-11-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
    });
    assert.strictEqual(res.status, 500);
    assert.ok(!client.calls.some((c) => /DETACH|DROP/i.test(c.sql || '')));
  }

  // Unsafe name
  {
    const client = fakeClient();
    const store = fakeStore();
    const res = await handler({
      pgClient: client,
      objectStore: store,
      request: {
        body: JSON.stringify({
          id: 'arch-3',
          tenant_id: 'tenant-a',
          payload: {
            now: '2026-11-19T12:00:00.000Z',
            partitions: [
              {
                name: 'memory_items_episodic_2023_10; DROP',
                upper_bound: '2020-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
    });
    assert.strictEqual(res.status, 400);
    assert.ok(!store.puts.length);
    assert.ok(!client.calls.some((c) => /DROP TABLE/i.test(c.sql || '')));
  }

  // Missing tenant_id
  {
    const res = await handler({
      pgClient: fakeClient(),
      objectStore: fakeStore(),
      request: {
        body: JSON.stringify({ id: 'arch-4', payload: { partitions: [] } }),
      },
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.archive.error');
  }

  // Bad pooler host
  {
    process.env.AURA_DATABASE_HOST = 'aura-pg-rw.aura.svc.cluster.local';
    const res = await handler({
      pgClient: fakeClient(),
      objectStore: fakeStore(),
      request: {
        body: JSON.stringify({
          id: 'arch-5',
          tenant_id: 't',
          payload: { partitions: [] },
        }),
      },
    });
    assert.strictEqual(res.status, 500);
    process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';
  }

  assert.strictEqual(typeof handler.runArchiveOnce, 'function');
  console.log('handler.selftest: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
