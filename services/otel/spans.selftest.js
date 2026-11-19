'use strict';

const assert = require('assert');
const {
  buildFunctionSpanAttributes,
  buildNatsSpanAttributes,
  buildPgSpanAttributes,
} = require('./spans');
const { MASK } = require('../control/secrets-mask');

function ctx() {
  return {
    tenant_id: 'tenant-a',
    session_id: 'sess-b',
    run_id: 'run-c',
  };
}

function main() {
  const fn = buildFunctionSpanAttributes({
    ...ctx(),
    function_name: 'aura-memory-recall',
    rpc_subject: 'aura.rpc.memory.recall',
    secrets: { api_key: 'sk-SHOULD-NOT-APPEAR' },
    authorization: 'Bearer leak',
  });
  assert.strictEqual(fn['aura.tenant_id'], 'tenant-a');
  assert.strictEqual(fn['aura.session_id'], 'sess-b');
  assert.strictEqual(fn['aura.run_id'], 'run-c');
  assert.strictEqual(fn['faas.name'], 'aura-memory-recall');
  assert.strictEqual(fn['aura.rpc.subject'], 'aura.rpc.memory.recall');
  const fnJson = JSON.stringify(fn);
  assert.ok(!fnJson.includes('sk-SHOULD-NOT-APPEAR'));
  assert.ok(!fnJson.includes('Bearer leak'));
  assert.ok(!fnJson.includes('api_key') || !fnJson.includes('sk-'));

  const nats = buildNatsSpanAttributes({
    ...ctx(),
    operation: 'publish',
    subject: 'aura.stream.run-c',
    token: 'nats-token-leak',
    password: 'nats-pass',
  });
  assert.strictEqual(nats['messaging.system.name'], 'nats');
  assert.strictEqual(nats['messaging.operation.name'], 'publish');
  assert.strictEqual(nats['messaging.destination.name'], 'aura.stream.run-c');
  const natsJson = JSON.stringify(nats);
  assert.ok(!natsJson.includes('nats-token-leak'));
  assert.ok(!natsJson.includes('nats-pass'));

  const pg = buildPgSpanAttributes({
    ...ctx(),
    operation: 'SELECT',
    summary: 'SELECT memory_items',
    query_text: 'SELECT * FROM memory_items WHERE tenant_id = $1',
    query_params: ['tenant-a', 'secret-row'],
    connection_string: 'postgres://user:s3cret@pooler:5432/aura',
  });
  assert.strictEqual(pg['db.system.name'], 'postgresql');
  assert.strictEqual(pg['db.operation.name'], 'SELECT');
  assert.strictEqual(pg['db.query.summary'], 'SELECT memory_items');
  assert.strictEqual(pg['db.query.text'], 'SELECT * FROM memory_items WHERE tenant_id = $1');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(pg, 'db.query.parameter.1'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(pg, 'db.connection_string'), false);
  const pgJson = JSON.stringify(pg);
  assert.ok(!pgJson.includes('s3cret'));
  assert.ok(!pgJson.includes('secret-row'));
  assert.ok(!pgJson.includes(MASK) || pgJson.includes('postgresql'));

  assert.throws(
    () => buildFunctionSpanAttributes({ tenant_id: 't', function_name: 'x' }),
    /missing_context/,
  );

  console.log('spans.selftest: PASS');
}

main();
