'use strict';

const assert = require('assert');
const { planPartitionAction, planBatch, HOT } = require('./partition-plan');

function run() {
  assert.strictEqual(HOT.short_term, '14 days');
  assert.strictEqual(HOT.episodic, '24 months');
  assert.strictEqual(HOT.audit, '12 months');

  const now = new Date('2026-11-19T12:00:00.000Z');

  // short_term: U within 14d → keep
  {
    const r = planPartitionAction({
      kind: 'short_term',
      name: 'memory_items_short_term_2026_11',
      upperBoundExclusive: '2026-12-01T00:00:00.000Z',
      now,
    });
    assert.strictEqual(r.action, 'keep');
  }

  // short_term: U <= now-14d → drop
  {
    const r = planPartitionAction({
      kind: 'short_term',
      name: 'memory_items_short_term_2026_09',
      upperBoundExclusive: '2026-10-01T00:00:00.000Z',
      now,
    });
    assert.strictEqual(r.action, 'drop');
    assert.strictEqual(r.reason, 'past_hot_window');
  }

  // audit: within 12mo → keep
  {
    const r = planPartitionAction({
      kind: 'audit',
      name: 'memory_audit_2026_01',
      upperBoundExclusive: '2026-02-01T00:00:00.000Z',
      now,
    });
    assert.strictEqual(r.action, 'keep');
  }

  // audit: U <= now-12mo → drop
  {
    const r = planPartitionAction({
      kind: 'audit',
      name: 'memory_audit_2025_10',
      upperBoundExclusive: '2025-11-01T00:00:00.000Z',
      now,
    });
    assert.strictEqual(r.action, 'drop');
  }

  // episodic cold without archive → needs_archive (never silent DROP)
  {
    const r = planPartitionAction({
      kind: 'episodic',
      name: 'memory_items_episodic_2023_10',
      upperBoundExclusive: '2023-11-01T00:00:00.000Z',
      now,
      archived: false,
    });
    assert.strictEqual(r.action, 'needs_archive');
  }

  // episodic cold + archived → drop
  {
    const r = planPartitionAction({
      kind: 'episodic',
      name: 'memory_items_episodic_2023_10',
      upperBoundExclusive: '2023-11-01T00:00:00.000Z',
      now,
      archived: true,
    });
    assert.strictEqual(r.action, 'drop');
    assert.strictEqual(r.reason, 'archived_cold_episodic');
  }

  // Soft-delete-only must not be a valid action token
  const batch = planBatch(
    [
      {
        kind: 'short_term',
        name: 'memory_items_short_term_2025_01',
        upperBoundExclusive: '2025-02-01T00:00:00.000Z',
      },
      {
        kind: 'episodic',
        name: 'memory_items_episodic_2023_01',
        upperBoundExclusive: '2023-02-01T00:00:00.000Z',
        archived: false,
      },
      {
        kind: 'audit',
        name: 'memory_audit_2024_10',
        upperBoundExclusive: '2024-11-01T00:00:00.000Z',
      },
    ],
    now
  );
  assert.ok(batch.some((x) => x.action === 'drop' && x.kind === 'short_term'));
  assert.ok(batch.some((x) => x.action === 'needs_archive' && x.kind === 'episodic'));
  assert.ok(batch.some((x) => x.action === 'drop' && x.kind === 'audit'));
  assert.ok(!batch.some((x) => x.action === 'soft_delete'));

  console.log('partition-plan.selftest: PASS');
}

run();
