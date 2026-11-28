'use strict';

const assert = require('assert');
const { createSecretsCache, ROTATE_SUBJECT, MAX_TTL_MS } = require('./secrets-cache');

function main() {
  let t = 1_000_000;
  const cache = createSecretsCache({ ttlMs: 60_000, now: () => t });

  assert.strictEqual(cache.ttlMs, 60_000);
  assert.throws(() => createSecretsCache({ ttlMs: MAX_TTL_MS + 1 }), /ttl_exceeds_max/);

  cache.set('ref-a', { v: 1 });
  assert.deepStrictEqual(cache.get('ref-a'), { v: 1 });

  t += 60_001;
  assert.strictEqual(cache.get('ref-a'), undefined);

  cache.set('tenant:t1:ref-b', { v: 2 });
  cache.set('tenant:t2:ref-c', { v: 3 });
  const rot = cache.handleRotatedEvent({
    subject: ROTATE_SUBJECT,
    secrets_ref: 'tenant:t1:ref-b',
  });
  assert.strictEqual(rot.action, 'invalidate_key');
  assert.strictEqual(cache.get('tenant:t1:ref-b'), undefined);
  assert.deepStrictEqual(cache.get('tenant:t2:ref-c'), { v: 3 });

  cache.set('tenant:t1:x', { a: 1 });
  cache.set('tenant:t1:y', { b: 2 });
  const tenantRot = cache.handleRotatedEvent({
    subject: ROTATE_SUBJECT,
    tenant_id: 't1',
  });
  assert.strictEqual(tenantRot.action, 'invalidate_tenant');
  assert.strictEqual(cache.get('tenant:t1:x'), undefined);
  assert.deepStrictEqual(cache.get('tenant:t2:ref-c'), { v: 3 });

  cache.set('k1', 1);
  cache.set('k2', 2);
  const all = cache.handleRotatedEvent({ subject: ROTATE_SUBJECT });
  assert.strictEqual(all.action, 'invalidate_all');
  assert.strictEqual(cache.size(), 0);

  const ignore = cache.handleRotatedEvent({ subject: 'other.subject' });
  assert.strictEqual(ignore.ok, false);

  console.log('secrets-cache.selftest: PASS');
}

main();