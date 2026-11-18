'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handler = require('./handler');

async function main() {
  const src = fs.readFileSync(path.join(__dirname, 'handler.js'), 'utf8');
  assert.ok(!/\brequire\(['"]pg['"]\)/.test(src), 'handler must not require pg');
  assert.ok(!/set_config/.test(src), 'handler must not call set_config');
  assert.ok(!/AURA_DATABASE_HOST/.test(src), 'handler must not reference AURA_DATABASE_HOST');
  assert.ok(!/\.query\s*\(/.test(src), 'handler must not call .query(');

  let extractCalls = 0;
  const res = await handler({
    request: {
      body: JSON.stringify({
        id: 'cap-1',
        type: 'memory.capture',
        tenant_id: 'tenant-a',
        payload: { session_id: 'sess-1', text: 'User prefers dark mode' },
      }),
    },
    extractCandidates: async (payload) => {
      extractCalls += 1;
      return [
        {
          memory_type: 'short_term',
          content: payload.text,
          session_id: payload.session_id,
        },
      ];
    },
    // Even if a pg client is injected, capture must ignore it (Zero Direct Write).
    pgClient: {
      async query() {
        throw new Error('pg_forbidden');
      },
    },
  });

  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.type, 'memory.candidates');
  assert.strictEqual(body.tenant_id, 'tenant-a');
  assert.strictEqual(body.id, 'cap-1');
  assert.ok(body.occurred_at);
  assert.strictEqual(body.content_ref, null);
  assert.strictEqual(extractCalls, 1);
  assert.deepStrictEqual(body.payload.candidates, [
    {
      memory_type: 'short_term',
      content: 'User prefers dark mode',
      session_id: 'sess-1',
    },
  ]);

  const defaultRes = await handler({
    request: {
      body: JSON.stringify({
        id: 'cap-2',
        tenant_id: 'tenant-b',
        payload: { text: 'hello', session_id: 's2' },
      }),
    },
  });
  assert.strictEqual(defaultRes.status, 200);
  const d = JSON.parse(defaultRes.body);
  assert.strictEqual(d.type, 'memory.candidates');
  assert.ok(Array.isArray(d.payload.candidates));
  assert.ok(d.payload.candidates.length >= 1);
  assert.ok(['short_term', 'episodic'].includes(d.payload.candidates[0].memory_type));

  const bad = await handler({
    request: { body: JSON.stringify({ id: 'x' }) },
  });
  assert.strictEqual(bad.status, 400);
  const badBody = JSON.parse(bad.body);
  assert.strictEqual(badBody.type, 'memory.capture.error');

  const badJson = await handler({
    request: { body: '{not-json' },
  });
  assert.strictEqual(badJson.status, 400);

  console.log('OK: memory_capture → memory.candidates; PG unused');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
