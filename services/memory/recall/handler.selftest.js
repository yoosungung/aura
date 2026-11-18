'use strict';

const assert = require('assert');
const { recallOnce, parseRequest } = require('./handler');

async function main() {
  // missing tenant_id → 400
  {
    const res = recallOnce({ query: 'hello', top_k: 3 });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'tenant_id_required');
  }

  // missing query → 400
  {
    const res = recallOnce({ tenant_id: 'tenant-a', top_k: 3 });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'query_required');
  }

  // happy path: sync stub — no PG / no JetStream side effects
  {
    const calls = [];
    const client = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    const req = {
      tenant_id: 'tenant-a',
      principal_id: 'user-1',
      session_id: 'sess-1',
      query: 'recent notes',
      types: ['short_term', 'episodic', 'long_term', 'semantic'],
      top_k: 12,
    };
    const res = recallOnce(req, { pgClient: client });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.recall.done');
    assert.strictEqual(body.tenant_id, 'tenant-a');
    assert.ok(Array.isArray(body.items));
    assert.strictEqual(body.items.length, 0, 'stub returns empty items until hybrid RRF sibling');
    assert.strictEqual(body.mode, 'stub');
    assert.strictEqual(body.subject, 'aura.rpc.memory.recall');
    assert.strictEqual(body.deploy_class, 'sync');
    assert.strictEqual(calls.length, 0, 'this slice must not touch PG (RRF is sibling)');
  }

  // parseRequest: Core RR raw string / buffer / object
  {
    assert.deepStrictEqual(parseRequest('{"tenant_id":"t","query":"q"}'), {
      tenant_id: 't',
      query: 'q',
    });
    assert.deepStrictEqual(parseRequest(Buffer.from('{"tenant_id":"t2","query":"q2"}')), {
      tenant_id: 't2',
      query: 'q2',
    });
    assert.deepStrictEqual(parseRequest({ tenant_id: 't3', query: 'q3' }), {
      tenant_id: 't3',
      query: 'q3',
    });
  }

  console.log('OK: recall handler selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
