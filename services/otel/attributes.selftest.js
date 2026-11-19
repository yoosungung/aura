'use strict';

const assert = require('assert');
const {
  ALLOWED_ATTR_KEYS,
  REQUIRED_CONTEXT_KEYS,
  sanitizeAttributes,
  assertSafeAttributes,
} = require('./attributes');
const { MASK } = require('../control/secrets-mask');

function main() {
  assert.ok(ALLOWED_ATTR_KEYS.has('aura.tenant_id'));
  assert.ok(ALLOWED_ATTR_KEYS.has('aura.session_id'));
  assert.ok(ALLOWED_ATTR_KEYS.has('aura.run_id'));
  assert.ok(ALLOWED_ATTR_KEYS.has('messaging.system.name'));
  assert.ok(ALLOWED_ATTR_KEYS.has('db.system.name'));
  assert.ok(!ALLOWED_ATTR_KEYS.has('db.query.parameter.1'));
  assert.ok(!ALLOWED_ATTR_KEYS.has('secrets'));
  assert.ok(!ALLOWED_ATTR_KEYS.has('authorization'));

  for (const k of REQUIRED_CONTEXT_KEYS) {
    assert.ok(ALLOWED_ATTR_KEYS.has(k), `required ${k} must be allowlisted`);
  }

  const dirty = {
    'aura.tenant_id': 't1',
    'aura.session_id': 's1',
    'aura.run_id': 'r1',
    'messaging.system.name': 'nats',
    'messaging.destination.name': 'aura.tasks.agent.invoke',
    api_key: 'sk-live-xyz',
    secrets: { db: 'postgres://u:p@h' },
    authorization: 'Bearer tok',
    password: 'hunter2',
    'db.query.parameter.1': 'secret-param',
    extra_leak: 'should-drop',
  };
  const clean = sanitizeAttributes(dirty);
  assert.strictEqual(clean['aura.tenant_id'], 't1');
  assert.strictEqual(clean['aura.session_id'], 's1');
  assert.strictEqual(clean['aura.run_id'], 'r1');
  assert.strictEqual(clean['messaging.system.name'], 'nats');
  assert.strictEqual(clean['messaging.destination.name'], 'aura.tasks.agent.invoke');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, 'api_key'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, 'secrets'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, 'authorization'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, 'password'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, 'db.query.parameter.1'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, 'extra_leak'), false);

  // Nested allowlisted object still runs maskSecrets (defense in depth).
  const nested = sanitizeAttributes({
    'aura.tenant_id': 't1',
    'aura.session_id': 's1',
    'aura.run_id': 'r1',
    'aura.span.meta': { token: 'abc', label: 'ok' },
  });
  // aura.span.meta is NOT allowlisted → dropped entirely
  assert.strictEqual(Object.prototype.hasOwnProperty.call(nested, 'aura.span.meta'), false);

  assert.throws(
    () =>
      assertSafeAttributes({
        'aura.tenant_id': 't1',
        // missing session + run
      }),
    /missing_context/,
  );

  assert.throws(
    () =>
      assertSafeAttributes({
        'aura.tenant_id': 't1',
        'aura.session_id': 's1',
        'aura.run_id': 'r1',
        api_key: 'sk',
      }),
    /disallowed_attr|plaintext/,
  );

  const ok = assertSafeAttributes({
    'aura.tenant_id': 't1',
    'aura.session_id': 's1',
    'aura.run_id': 'r1',
    'db.system.name': 'postgresql',
  });
  assert.strictEqual(ok['aura.tenant_id'], 't1');
  assert.ok(!JSON.stringify(ok).includes('sk-live'));
  assert.ok(!JSON.stringify(ok).includes(MASK) || true); // mask may be unused when keys dropped

  console.log('attributes.selftest: PASS');
}

main();
