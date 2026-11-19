'use strict';

const assert = require('assert');
const {
  planCandidates,
  idempotentTaskId,
  GRACE_DAYS,
  BATCH_LIMIT,
  BUCKET,
  isRefsKey,
} = require('./plan');

function run() {
  assert.strictEqual(GRACE_DAYS, 90);
  assert.strictEqual(BATCH_LIMIT, 100);
  assert.strictEqual(BUCKET, 'aura-content');

  const now = new Date('2026-11-19T12:00:00.000Z');

  assert.ok(isRefsKey('t1', 'tenants/t1/refs/2024/01/abc'));
  assert.ok(!isRefsKey('t1', 'tenants/t1/archive/episodic/2023/10/x.parquet'));
  assert.ok(!isRefsKey('t1', 'tenants/t1/bundles/k/n/v'));
  assert.ok(!isRefsKey('t1', 'tenants/other/refs/x'));

  const planned = planCandidates({
    tenant_id: 't1',
    now,
    limit: 2,
    objects: [
      {
        key: 'tenants/t1/refs/2024/01/old',
        lastModified: '2026-01-01T00:00:00.000Z', // >90d before now? Jan 1 to Nov 19 is >90d yes
      },
      {
        key: 'tenants/t1/refs/2026/11/young',
        lastModified: '2026-11-01T00:00:00.000Z', // <90d
      },
      {
        key: 'tenants/t1/archive/episodic/2023/10/p.parquet',
        lastModified: '2020-01-01T00:00:00.000Z',
      },
      {
        key: 'tenants/t1/refs/2023/05/old2',
        lastModified: '2025-01-01T00:00:00.000Z',
      },
      {
        key: 'tenants/t1/refs/2022/01/old3',
        lastModified: '2024-01-01T00:00:00.000Z',
      },
    ],
  });

  assert.strictEqual(planned.candidates.length, 2); // batch limit
  assert.ok(planned.candidates.every((c) => c.key.includes('/refs/')));
  assert.ok(planned.skipped_young.includes('tenants/t1/refs/2026/11/young'));
  assert.ok(
    planned.skipped_prefix.includes(
      'tenants/t1/archive/episodic/2023/10/p.parquet'
    )
  );

  assert.strictEqual(idempotentTaskId('t1', now), 'object-gc:t1:2026-11-19');
  assert.strictEqual(idempotentTaskId('all', now), 'object-gc:all:2026-11-19');

  console.log('object-gc plan.selftest: PASS');
}

run();
