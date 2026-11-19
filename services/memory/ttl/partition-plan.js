'use strict';

/**
 * Monthly partition TTL planner (ARCHITECTURE §6.2.2 · memory-ttl-policy.md).
 * DROP iff exclusive upper bound U <= now() - hot interval.
 * episodic cold → needs_archive unless archived=true (archive task owns Parquet path).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hot windows as PG-interval strings (M1 fixed). */
const HOT = Object.freeze({
  short_term: '14 days',
  episodic: '24 months',
  audit: '12 months',
});

/**
 * @param {Date} now
 * @param {'short_term'|'episodic'|'audit'} kind
 * @returns {Date}
 */
function hotCutoff(now, kind) {
  const n = new Date(now.getTime());
  if (kind === 'short_term') {
    return new Date(n.getTime() - 14 * DAY_MS);
  }
  if (kind === 'episodic') {
    n.setUTCMonth(n.getUTCMonth() - 24);
    return n;
  }
  if (kind === 'audit') {
    n.setUTCMonth(n.getUTCMonth() - 12);
    return n;
  }
  const err = new Error('kind_invalid');
  err.code = 'kind_invalid';
  err.status = 400;
  throw err;
}

/**
 * @param {{
 *   kind: 'short_term'|'episodic'|'audit',
 *   name: string,
 *   upperBoundExclusive: string|Date,
 *   now?: string|Date,
 *   archived?: boolean,
 * }} input
 */
function planPartitionAction(input) {
  if (!input || !input.kind || !input.name || input.upperBoundExclusive == null) {
    const err = new Error('partition_identity_required');
    err.code = 'partition_identity_required';
    err.status = 400;
    throw err;
  }
  const now = input.now != null ? new Date(input.now) : new Date();
  const U = new Date(input.upperBoundExclusive);
  if (Number.isNaN(now.getTime()) || Number.isNaN(U.getTime())) {
    const err = new Error('timestamp_invalid');
    err.code = 'timestamp_invalid';
    err.status = 400;
    throw err;
  }

  const cutoff = hotCutoff(now, input.kind);
  if (U.getTime() > cutoff.getTime()) {
    return {
      action: 'keep',
      reason: 'within_hot_window',
      kind: input.kind,
      name: input.name,
      upper_bound: U.toISOString(),
      cutoff: cutoff.toISOString(),
    };
  }

  if (input.kind === 'episodic') {
    if (!input.archived) {
      return {
        action: 'needs_archive',
        reason: 'cold_episodic_requires_archive',
        kind: input.kind,
        name: input.name,
        upper_bound: U.toISOString(),
        cutoff: cutoff.toISOString(),
      };
    }
    return {
      action: 'drop',
      reason: 'archived_cold_episodic',
      kind: input.kind,
      name: input.name,
      upper_bound: U.toISOString(),
      cutoff: cutoff.toISOString(),
    };
  }

  return {
    action: 'drop',
    reason: 'past_hot_window',
    kind: input.kind,
    name: input.name,
    upper_bound: U.toISOString(),
    cutoff: cutoff.toISOString(),
  };
}

/**
 * @param {Array<object>} partitions
 * @param {string|Date} [now]
 */
function planBatch(partitions, now) {
  if (!Array.isArray(partitions)) {
    const err = new Error('partitions_required');
    err.code = 'partitions_required';
    err.status = 400;
    throw err;
  }
  return partitions.map((p) =>
    planPartitionAction({
      ...p,
      now: now != null ? now : p.now,
    })
  );
}

module.exports = {
  HOT,
  hotCutoff,
  planPartitionAction,
  planBatch,
};
