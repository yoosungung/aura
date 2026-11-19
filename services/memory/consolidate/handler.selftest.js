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
  // Reject similarity-only without opening a promote path that mutates type.
  {
    const client = fakeClient();
    const res = await handler({
      pgClient: client,
      request: {
        body: JSON.stringify({
          id: 'evt-1',
          tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          payload: {
            item_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            created_at: '2026-11-01T00:00:00.000Z',
            from_type: 'episodic',
            to_type: 'long_term',
            reason: 'similarity_only',
            similarity: 0.99,
          },
        }),
      },
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'similarity_only_forbidden');
    assert.ok(!client.calls.some((c) => /UPDATE\s+memory_type/i.test(c.sql)));
  }

  // Happy path stub: withTenantTx + soft_close intent; no UPDATE memory_type.
  {
    process.env.AURA_DATABASE_HOST = 'aura-pg-pooler.aura.svc.cluster.local';
    const client = fakeClient();
    const res = await handler({
      pgClient: client,
      request: {
        body: JSON.stringify({
          id: 'evt-2',
          tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          payload: {
            item_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            created_at: '2026-11-01T00:00:00.000Z',
            from_type: 'short_term',
            to_type: 'episodic',
            reason: 'session_boundary',
          },
        }),
      },
    });
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.consolidated');
    assert.strictEqual(body.payload.from_type, 'short_term');
    assert.strictEqual(body.payload.to_type, 'episodic');
    assert.ok(client.calls.some((c) => /set_config\('app\.tenant_id'/.test(c.sql)));
    assert.ok(!client.calls.some((c) => /UPDATE\s+.*memory_type/i.test(c.sql)));
    assert.ok(
      client.calls.some(
        (c) =>
          typeof c.sql === 'string' &&
          c.sql.includes('aura.tasks.memory.consolidate') &&
          /soft_close|insert_promoted/.test(c.sql)
      )
    );
  }

  // store/embed must not be the writer — handler is the only promote entry (identity check).
  assert.strictEqual(typeof handler.consolidateOnce, 'function');
  assert.strictEqual(typeof handler.planPromotion, 'function');

  console.log('handler.selftest: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
