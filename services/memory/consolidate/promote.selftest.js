'use strict';

/**
 * M4: type-promotion rules — consolidate only; no similarity-only type change.
 */
const assert = require('assert');
const {
  ALLOWED_TRANSITIONS,
  VALID_REASONS,
  planPromotion,
  isAllowedTransition,
} = require('./promote');

function throws(fn, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected throw');
  assert.strictEqual(err.code || err.message, code);
}

// Allowed edges only (ARCHITECTURE §5 chain).
assert.strictEqual(isAllowedTransition('short_term', 'episodic'), true);
assert.strictEqual(isAllowedTransition('episodic', 'long_term'), true);
assert.strictEqual(isAllowedTransition('episodic', 'semantic'), true);
assert.strictEqual(isAllowedTransition('short_term', 'long_term'), false);
assert.strictEqual(isAllowedTransition('short_term', 'semantic'), false);
assert.strictEqual(isAllowedTransition('long_term', 'semantic'), false);
assert.strictEqual(isAllowedTransition('semantic', 'episodic'), false);
assert.strictEqual(isAllowedTransition('episodic', 'short_term'), false);
assert.strictEqual(isAllowedTransition('episodic', 'episodic'), false);

assert.deepStrictEqual(
  [...ALLOWED_TRANSITIONS].sort(),
  ['episodic->long_term', 'episodic->semantic', 'short_term->episodic'].sort()
);

assert.ok(VALID_REASONS.has('session_boundary'));
assert.ok(VALID_REASONS.has('recurrence'));
assert.ok(VALID_REASONS.has('llm_extract'));
assert.ok(VALID_REASONS.has('operator'));
assert.ok(!VALID_REASONS.has('similarity_only'));

// Happy path: short_term → episodic via session_boundary.
{
  const plan = planPromotion({
    from_type: 'short_term',
    to_type: 'episodic',
    reason: 'session_boundary',
    item_id: '11111111-1111-1111-1111-111111111111',
    created_at: '2026-11-01T00:00:00.000Z',
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.ops.length, 2);
  assert.strictEqual(plan.ops[0].op, 'soft_close');
  assert.strictEqual(plan.ops[1].op, 'insert_promoted');
  assert.strictEqual(plan.ops[1].memory_type, 'episodic');
  assert.strictEqual(plan.ops[1].supersedes_id, '11111111-1111-1111-1111-111111111111');
  // LIST partition: never in-place UPDATE memory_type.
  assert.ok(!plan.ops.some((o) => o.op === 'update_memory_type'));
}

// Similarity score alone must not promote (M4 success criterion).
throws(
  () =>
    planPromotion({
      from_type: 'episodic',
      to_type: 'long_term',
      reason: 'similarity_only',
      similarity: 0.99,
      item_id: '22222222-2222-2222-2222-222222222222',
      created_at: '2026-10-01T00:00:00.000Z',
    }),
  'similarity_only_forbidden'
);

throws(
  () =>
    planPromotion({
      from_type: 'episodic',
      to_type: 'semantic',
      // missing reason; only a score
      similarity: 0.95,
      item_id: '33333333-3333-3333-3333-333333333333',
      created_at: '2026-10-01T00:00:00.000Z',
    }),
  'reason_required'
);

// Illegal edge rejected even with valid reason.
throws(
  () =>
    planPromotion({
      from_type: 'short_term',
      to_type: 'long_term',
      reason: 'operator',
      item_id: '44444444-4444-4444-4444-444444444444',
      created_at: '2026-11-01T00:00:00.000Z',
    }),
  'transition_not_allowed'
);

// recurrence needs evidence_count ≥ 3 (M4 fixed).
throws(
  () =>
    planPromotion({
      from_type: 'episodic',
      to_type: 'long_term',
      reason: 'recurrence',
      evidence_count: 2,
      item_id: '55555555-5555-5555-5555-555555555555',
      created_at: '2026-09-01T00:00:00.000Z',
    }),
  'recurrence_below_threshold'
);

{
  const plan = planPromotion({
    from_type: 'episodic',
    to_type: 'long_term',
    reason: 'recurrence',
    evidence_count: 3,
    similarity: 0.9, // allowed as accessory, not sole trigger
    item_id: '66666666-6666-6666-6666-666666666666',
    created_at: '2026-09-01T00:00:00.000Z',
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.ops[1].memory_type, 'long_term');
}

console.log('promote.selftest: PASS');
