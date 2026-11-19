'use strict';

const assert = require('assert');
const {
  planErase,
  resolveKids,
  idempotentTaskId,
  STEPS,
  KMS_PRODUCT,
  kidTenant,
  kidUser,
  PENDING_HOURS,
} = require('./plan');

function main() {
  assert.strictEqual(KMS_PRODUCT, 'openbao-transit');
  assert.strictEqual(PENDING_HOURS, 24);
  assert.deepStrictEqual(STEPS, [
    'validate',
    'shred_keys',
    'invalidate_secrets_cache',
    'pg_redact',
    'delete_objects',
    'emit_done',
  ]);
  assert.ok(STEPS.indexOf('shred_keys') < STEPS.indexOf('pg_redact'));
  assert.ok(STEPS.indexOf('shred_keys') < STEPS.indexOf('delete_objects'));

  assert.throws(() => planErase({}), /tenant_id_required/);
  assert.throws(() => resolveKids({ tenant_id: 't1', scope: 'user' }), /user_id_required/);

  assert.strictEqual(kidTenant('t1', 1), 'tenant:t1:v1');
  assert.strictEqual(kidUser('t1', 'u1', 2), 'tenant:t1:user:u1:v2');
  assert.deepStrictEqual(resolveKids({ tenant_id: 't1', scope: 'tenant' }), ['tenant:t1:v1']);
  assert.deepStrictEqual(resolveKids({ tenant_id: 't1', scope: 'user', user_id: 'u1' }), [
    'tenant:t1:user:u1:v1',
  ]);

  const plan = planErase({
    tenant_id: 't1',
    scope: 'user',
    user_id: 'u1',
    request_id: 'req-1',
    now: '2026-11-19T12:00:00Z',
    content_refs: [
      {
        bucket: 'aura-content',
        key: 'tenants/t1/refs/a',
        enc: { kid: 'tenant:t1:user:u1:v1' },
      },
      {
        bucket: 'aura-content',
        key: 'tenants/t1/archive/episodic/x',
        enc: { kid: 'tenant:t1:user:u1:v1' },
      },
      {
        bucket: 'other',
        key: 'tenants/t1/refs/b',
        enc: { kid: 'tenant:t1:user:u1:v1' },
      },
    ],
  });
  assert.strictEqual(plan.kms_product, 'openbao-transit');
  assert.deepStrictEqual(plan.kids_to_shred, ['tenant:t1:user:u1:v1']);
  assert.strictEqual(plan.object_targets.length, 1);
  assert.strictEqual(plan.object_targets[0].key, 'tenants/t1/refs/a');
  assert.ok(plan.skipped_prefix.includes('tenants/t1/archive/episodic/x'));
  assert.ok(plan.skipped_bucket.length >= 1);
  assert.strictEqual(plan.pending_hours, 24);
  assert.ok(plan.pending_until);

  const id = idempotentTaskId({
    tenant_id: 't1',
    scope: 'user',
    user_id: 'u1',
    request_id: 'req-1',
  });
  assert.strictEqual(id, 'erase:t1:user:u1:req-1');
  assert.strictEqual(
    idempotentTaskId({ tenant_id: 't1', scope: 'tenant', request_id: 'req-2' }),
    'erase:t1:tenant:req-2',
  );

  console.log('plan.selftest: PASS');
}

main();
