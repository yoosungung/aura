'use strict';

/**
 * Cold episodic archive planner (ARCHITECTURE §6.2.2 · object-store-content-ref.md).
 * Order: Parquet export → PutObject (aura-content archive/) → DETACH → DROP.
 * TTL marks needs_archive; this task owns Parquet + detach/drop.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOT_EPISODIC = Object.freeze({ interval: '24 months', months: 24 });
const BUCKET = 'aura-content';

const SAFE_EPISODIC =
  /^memory_items_episodic_(\d{4})_(\d{2})$/;

function hotCutoffEpisodic(now) {
  const n = new Date(now.getTime());
  n.setUTCMonth(n.getUTCMonth() - HOT_EPISODIC.months);
  return n;
}

function archiveObjectKey(tenantId, yyyy, mm, partitionName) {
  return `tenants/${tenantId}/archive/episodic/${yyyy}/${mm}/${partitionName}.parquet`;
}

/**
 * @param {{
 *   name: string,
 *   upperBoundExclusive: string|Date,
 *   tenant_id: string,
 *   now?: string|Date,
 *   object_exists?: boolean,
 * }} input
 */
function planArchiveAction(input) {
  if (!input || !input.name || input.upperBoundExclusive == null || !input.tenant_id) {
    const err = new Error('archive_identity_required');
    err.code = 'archive_identity_required';
    err.status = 400;
    throw err;
  }

  const m = SAFE_EPISODIC.exec(input.name);
  if (!m) {
    const err = new Error('partition_name_unsafe');
    err.code = 'partition_name_unsafe';
    err.status = 400;
    throw err;
  }
  const yyyy = m[1];
  const mm = m[2];

  const now = input.now != null ? new Date(input.now) : new Date();
  const U = new Date(input.upperBoundExclusive);
  if (Number.isNaN(now.getTime()) || Number.isNaN(U.getTime())) {
    const err = new Error('timestamp_invalid');
    err.code = 'timestamp_invalid';
    err.status = 400;
    throw err;
  }

  const cutoff = hotCutoffEpisodic(now);
  if (U.getTime() > cutoff.getTime()) {
    return {
      action: 'skip_hot',
      reason: 'within_hot_window',
      name: input.name,
      upper_bound: U.toISOString(),
      cutoff: cutoff.toISOString(),
    };
  }

  const key = archiveObjectKey(input.tenant_id, yyyy, mm, input.name);
  return {
    action: 'archive',
    reason: 'cold_episodic',
    name: input.name,
    kind: 'episodic',
    upper_bound: U.toISOString(),
    cutoff: cutoff.toISOString(),
    bucket: BUCKET,
    key,
    uri: `s3://${BUCKET}/${key}`,
    steps: ['export_parquet', 'put_object', 'verify', 'detach', 'drop'],
    object_exists: Boolean(input.object_exists),
  };
}

function planBatch(partitions, now) {
  if (!Array.isArray(partitions)) {
    const err = new Error('partitions_required');
    err.code = 'partitions_required';
    err.status = 400;
    throw err;
  }
  return partitions.map((p) =>
    planArchiveAction({
      ...p,
      now: now != null ? now : p.now,
    })
  );
}

module.exports = {
  HOT_EPISODIC,
  BUCKET,
  SAFE_EPISODIC,
  hotCutoffEpisodic,
  archiveObjectKey,
  planArchiveAction,
  planBatch,
};
