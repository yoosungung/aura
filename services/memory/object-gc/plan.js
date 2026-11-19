'use strict';

/**
 * Orphan content_ref GC planner (ARCHITECTURE §8 · object-store-orphan-gc.md).
 * refs/ only · grace 90d · batch ≤100 · skip if live PG ref.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 90;
const BATCH_LIMIT = 100;
const BUCKET = 'aura-content';

function graceCutoff(now) {
  return new Date(now.getTime() - GRACE_DAYS * DAY_MS);
}

function refsPrefix(tenantId) {
  return `tenants/${tenantId}/refs/`;
}

function isRefsKey(tenantId, key) {
  const prefix = refsPrefix(tenantId);
  if (!key || typeof key !== 'string') return false;
  if (!key.startsWith(prefix)) return false;
  if (key.includes('/archive/') || key.includes('/bundles/')) return false;
  return true;
}

/**
 * Filter listed objects to orphan candidates (age + prefix). Live-ref check is handler.
 *
 * @param {{
 *   tenant_id: string,
 *   objects: Array<{ key: string, lastModified: string|Date }>,
 *   now?: string|Date,
 *   limit?: number,
 * }} input
 */
function planCandidates(input) {
  if (!input || !input.tenant_id) {
    const err = new Error('tenant_id_required');
    err.code = 'tenant_id_required';
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(input.objects)) {
    const err = new Error('objects_required');
    err.code = 'objects_required';
    err.status = 400;
    throw err;
  }

  const now = input.now != null ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    const err = new Error('timestamp_invalid');
    err.code = 'timestamp_invalid';
    err.status = 400;
    throw err;
  }
  const cutoff = graceCutoff(now);
  const limit = input.limit != null ? Number(input.limit) : BATCH_LIMIT;
  const candidates = [];
  const skipped_young = [];
  const skipped_prefix = [];

  for (const obj of input.objects) {
    if (!obj || !obj.key) continue;
    if (!isRefsKey(input.tenant_id, obj.key)) {
      skipped_prefix.push(obj.key);
      continue;
    }
    const lm = new Date(obj.lastModified);
    if (Number.isNaN(lm.getTime()) || lm.getTime() > cutoff.getTime()) {
      skipped_young.push(obj.key);
      continue;
    }
    candidates.push({
      bucket: BUCKET,
      key: obj.key,
      last_modified: lm.toISOString(),
    });
    if (candidates.length >= limit) break;
  }

  return {
    tenant_id: input.tenant_id,
    bucket: BUCKET,
    prefix: refsPrefix(input.tenant_id),
    grace_days: GRACE_DAYS,
    cutoff: cutoff.toISOString(),
    batch_limit: limit,
    candidates,
    skipped_young,
    skipped_prefix,
  };
}

/** Idempotent task id for UTC day. */
function idempotentTaskId(tenantId, now) {
  const d = now != null ? new Date(now) : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const scope = tenantId || 'all';
  return `object-gc:${scope}:${yyyy}-${mm}-${dd}`;
}

module.exports = {
  GRACE_DAYS,
  BATCH_LIMIT,
  BUCKET,
  graceCutoff,
  refsPrefix,
  isRefsKey,
  planCandidates,
  idempotentTaskId,
};
