'use strict';

const assert = require('assert');
const {
  planArchiveAction,
  planBatch,
  HOT_EPISODIC,
  BUCKET,
  archiveObjectKey,
} = require('./plan');

function run() {
  assert.strictEqual(HOT_EPISODIC.months, 24);
  assert.strictEqual(BUCKET, 'aura-content');

  const now = new Date('2026-11-19T12:00:00.000Z');

  // hot episodic → skip
  {
    const r = planArchiveAction({
      name: 'memory_items_episodic_2026_01',
      upperBoundExclusive: '2026-02-01T00:00:00.000Z',
      tenant_id: 't1',
      now,
    });
    assert.strictEqual(r.action, 'skip_hot');
  }

  // cold → archive with object-store path
  {
    const r = planArchiveAction({
      name: 'memory_items_episodic_2023_10',
      upperBoundExclusive: '2023-11-01T00:00:00.000Z',
      tenant_id: 't1',
      now,
    });
    assert.strictEqual(r.action, 'archive');
    assert.strictEqual(r.bucket, 'aura-content');
    assert.strictEqual(
      r.key,
      'tenants/t1/archive/episodic/2023/10/memory_items_episodic_2023_10.parquet'
    );
    assert.deepStrictEqual(r.steps, [
      'export_parquet',
      'put_object',
      'verify',
      'detach',
      'drop',
    ]);
    assert.ok(r.uri.startsWith('s3://aura-content/tenants/t1/archive/'));
  }

  // helper key shape
  {
    assert.strictEqual(
      archiveObjectKey('abc', '2022', '03', 'memory_items_episodic_2022_03'),
      'tenants/abc/archive/episodic/2022/03/memory_items_episodic_2022_03.parquet'
    );
  }

  // unsafe name
  {
    let threw = false;
    try {
      planArchiveAction({
        name: 'memory_items_short_term_2020_01',
        upperBoundExclusive: '2020-02-01T00:00:00.000Z',
        tenant_id: 't1',
        now,
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'partition_name_unsafe');
    }
    assert.ok(threw);
  }

  const batch = planBatch(
    [
      {
        name: 'memory_items_episodic_2023_01',
        upperBoundExclusive: '2023-02-01T00:00:00.000Z',
        tenant_id: 't1',
      },
      {
        name: 'memory_items_episodic_2026_10',
        upperBoundExclusive: '2026-11-01T00:00:00.000Z',
        tenant_id: 't1',
      },
    ],
    now
  );
  assert.ok(batch.some((x) => x.action === 'archive'));
  assert.ok(batch.some((x) => x.action === 'skip_hot'));

  console.log('archive plan.selftest: PASS');
}

run();
