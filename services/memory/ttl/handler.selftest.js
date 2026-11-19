'use strict';

const assert = require('assert');
const handler = require('./handler');

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

async function run() {
  process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';

  // Drop short_term + audit; episodic cold without archive → needs_archive (no DROP)
  {
    const client = fakeClient();
    const res = await handler({
      pgClient: client,
      request: {
        body: JSON.stringify({
          id: 'ttl-1',
          tenant_id: 'platform',
          payload: {
            now: '2026-11-19T12:00:00.000Z',
            partitions: [
              {
                kind: 'short_term',
                name: 'memory_items_short_term_2026_09',
                upper_bound: '2026-10-01T00:00:00.000Z',
              },
              {
                kind: 'episodic',
                name: 'memory_items_episodic_2023_10',
                upper_bound: '2023-11-01T00:00:00.000Z',
                archived: false,
              },
              {
                kind: 'audit',
                name: 'memory_audit_2025_10',
                upper_bound: '2025-11-01T00:00:00.000Z',
              },
              {
                kind: 'short_term',
                name: 'memory_items_short_term_2026_11',
                upper_bound: '2026-12-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
    });
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.ttl.done');
    assert.strictEqual(body.payload.dropped.length, 2);
    assert.ok(body.payload.dropped.includes('memory_items_short_term_2026_09'));
    assert.ok(body.payload.dropped.includes('memory_audit_2025_10'));
    assert.strictEqual(body.payload.needs_archive.length, 1);
    assert.strictEqual(body.payload.kept.length, 1);
    const dropSql = client.calls.filter(
      (c) => typeof c.sql === 'string' && /DROP TABLE/i.test(c.sql)
    );
    assert.strictEqual(dropSql.length, 2);
    assert.ok(dropSql.every((c) => c.sql.includes('aura.tasks.memory.ttl')));
    assert.ok(dropSql.every((c) => /RESTRICT/i.test(c.sql)));
    assert.ok(dropSql.every((c) => !/CASCADE/i.test(c.sql)));
    assert.ok(
      !client.calls.some(
        (c) =>
          typeof c.sql === 'string' &&
          /DROP TABLE/i.test(c.sql) &&
          c.sql.includes('memory_items_episodic_2023_10')
      )
    );
    // No soft-delete / row DELETE path
    assert.ok(!client.calls.some((c) => /UPDATE\s+.*valid_until/i.test(c.sql || '')));
    assert.ok(!client.calls.some((c) => /DELETE\s+FROM\s+memory_/i.test(c.sql || '')));
  }

  // archived episodic → DROP
  {
    const client = fakeClient();
    const res = await handler({
      pgClient: client,
      request: {
        body: JSON.stringify({
          id: 'ttl-2',
          payload: {
            now: '2026-11-19T12:00:00.000Z',
            partitions: [
              {
                kind: 'episodic',
                name: 'memory_items_episodic_2023_10',
                upper_bound: '2023-11-01T00:00:00.000Z',
                archived: true,
              },
            ],
          },
        }),
      },
    });
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.payload.dropped, ['memory_items_episodic_2023_10']);
    assert.ok(client.calls.some((c) => /DROP TABLE IF EXISTS memory_items_episodic_2023_10/i.test(c.sql)));
  }

  // Reject unsafe partition names
  {
    const client = fakeClient();
    const res = await handler({
      pgClient: client,
      request: {
        body: JSON.stringify({
          id: 'ttl-3',
          payload: {
            now: '2026-11-19T12:00:00.000Z',
            partitions: [
              {
                kind: 'short_term',
                name: 'memory_items; DROP TABLE users',
                upper_bound: '2020-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
    });
    assert.strictEqual(res.status, 400);
    assert.ok(!client.calls.some((c) => /DROP TABLE/i.test(c.sql || '')));
  }

  // Bad pooler host
  {
    process.env.AURA_DATABASE_HOST = 'aura-pg-rw.aura.svc.cluster.local';
    const res = await handler({
      pgClient: fakeClient(),
      request: { body: JSON.stringify({ id: 'ttl-4', payload: { partitions: [] } }) },
    });
    assert.strictEqual(res.status, 500);
    process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';
  }

  assert.strictEqual(typeof handler.runTtlOnce, 'function');
  assert.strictEqual(typeof handler.planPartitionAction, 'function');

  console.log('handler.selftest: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
