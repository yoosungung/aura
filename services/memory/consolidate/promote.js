'use strict';

/**
 * Type-promotion rules for aura.tasks.memory.consolidate (ARCHITECTURE §5 · M4).
 * Only this module (via consolidate) may change memory_type. Similarity alone never promotes.
 *
 * LIST(memory_type) partition: never UPDATE memory_type in place —
 * soft_close source + INSERT promoted row with supersedes_id.
 */

const ALLOWED_TRANSITIONS = new Set([
  'short_term->episodic',
  'episodic->long_term',
  'episodic->semantic',
]);

const VALID_REASONS = new Set([
  'session_boundary',
  'recurrence',
  'llm_extract',
  'operator',
]);

/** M4 fixed — recurrence evidence floor (tunable later via decision log). */
const RECURRENCE_MIN_EVIDENCE = 3;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  err.status = 400;
  throw err;
}

function isAllowedTransition(fromType, toType) {
  return ALLOWED_TRANSITIONS.has(`${fromType}->${toType}`);
}

/**
 * Plan a type promotion. Does not touch PG — returns ops for consolidate writer.
 *
 * @param {{
 *   from_type: string,
 *   to_type: string,
 *   reason?: string,
 *   similarity?: number,
 *   evidence_count?: number,
 *   item_id: string,
 *   created_at: string,
 * }} input
 */
function planPromotion(input) {
  if (!input || !input.item_id || !input.created_at) {
    fail('item_identity_required');
  }
  if (!input.from_type || !input.to_type) {
    fail('types_required');
  }

  const reason = input.reason;
  if (!reason) {
    fail('reason_required');
  }
  if (reason === 'similarity_only') {
    fail('similarity_only_forbidden');
  }
  if (!VALID_REASONS.has(reason)) {
    fail('reason_invalid');
  }

  if (!isAllowedTransition(input.from_type, input.to_type)) {
    fail('transition_not_allowed');
  }

  if (reason === 'recurrence') {
    const n = Number(input.evidence_count);
    if (!Number.isFinite(n) || n < RECURRENCE_MIN_EVIDENCE) {
      fail('recurrence_below_threshold');
    }
  }

  // similarity may accompany a valid reason; never sufficient alone (handled above).
  return {
    ok: true,
    from_type: input.from_type,
    to_type: input.to_type,
    reason,
    ops: [
      {
        op: 'soft_close',
        item_id: input.item_id,
        memory_type: input.from_type,
        created_at: input.created_at,
      },
      {
        op: 'insert_promoted',
        memory_type: input.to_type,
        supersedes_id: input.item_id,
        source_created_at: input.created_at,
      },
    ],
  };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  VALID_REASONS,
  RECURRENCE_MIN_EVIDENCE,
  isAllowedTransition,
  planPromotion,
};
