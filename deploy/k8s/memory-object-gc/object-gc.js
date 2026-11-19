'use strict';

/**
 * Fission Package entry for aura.tasks.memory.object_gc (ARCHITECTURE §3.2 · §8).
 * Source of truth: services/memory/object-gc/{plan,handler}.js + store/tenant-tx.js
 */

/**
 * Transaction-local tenant GUC for Pooler (ARCHITECTURE §1 #4 · §2.1).
 * Always: SELECT set_config('app.tenant_id', $1, true) — never false / session SET.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<unknown> }} client
 * @param {string} tenantId
 * @param {(client: typeof client) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTenantTx(client, tenantId, fn) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenant_id_required');
  }
  await client.query('BEGIN');
  try {
    // is_local=true → cleared on COMMIT/ROLLBACK (transaction pooling safe)
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback errors */
    }
    throw err;
  }
}


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


/**
 * Fission MQT handler — aura.tasks.memory.object_gc (M4).
 * List refs/ older than 90d → skip if live PG content_ref → DeleteObject.
 *
 * Non-goals: live Garage provision · archive/bundles GC · erase · OTel.
 */

const LIVE_REF_SQL = `
SELECT 1 AS hit FROM (
  SELECT 1
  FROM memory_items
  WHERE tenant_id = $1::uuid
    AND metadata #>> '{content_ref,bucket}' = $2
    AND metadata #>> '{content_ref,key}' = $3
  LIMIT 1
  UNION ALL
  SELECT 1
  FROM memory_audit
  WHERE tenant_id = $1::uuid
    AND metadata #>> '{content_ref,bucket}' = $2
    AND metadata #>> '{content_ref,key}' = $3
  LIMIT 1
) x
LIMIT 1`;

function poolerHostOk(host) {
  if (!host) return false;
  if (!host.includes('aura-pg-pooler')) return false;
  if (/(^|[.-])aura-pg-rw($|[.-])|aura-pg-r($|[.-])|aura-pg-ro($|[.-])/.test(host)) {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return true;
}

function parseBody(req) {
  let raw = (req && req.body) != null ? req.body : '';
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function payloadOf(envelope) {
  return (envelope && envelope.payload) || {};
}

async function hasLiveRef(client, tenantId, bucket, key) {
  const res = await client.query(LIVE_REF_SQL, [tenantId, bucket, key]);
  return Array.isArray(res.rows) && res.rows.length > 0;
}

/**
 * @param {{ query: Function }} client
 * @param {{
 *   listObjects?: Function,
 *   deleteObject?: Function,
 * }} objectStore
 * @param {object} envelope
 */
async function runObjectGcOnce(client, objectStore, envelope) {
  const tenantId = envelope && envelope.tenant_id;
  if (!tenantId) {
    const err = new Error('tenant_id_required');
    err.status = 400;
    throw err;
  }

  const p = payloadOf(envelope);
  const now = p.now || new Date().toISOString();
  const id = (envelope && envelope.id) || idempotentTaskId(tenantId, now);

  const store = objectStore || {};
  if (typeof store.listObjects !== 'function' || typeof store.deleteObject !== 'function') {
    const err = new Error('object_store_required');
    err.code = 'object_store_required';
    err.status = 500;
    throw err;
  }

  const listed = await store.listObjects({
    bucket: BUCKET,
    prefix: refsPrefix(tenantId),
  });
  const objects = Array.isArray(listed) ? listed : listed && listed.objects ? listed.objects : [];

  const planned = planCandidates({
    tenant_id: tenantId,
    objects,
    now,
    limit: p.limit != null ? Number(p.limit) : BATCH_LIMIT,
  });

  const deleted = [];
  const skipped_live = [];

  await withTenantTx(client, tenantId, async (c) => {
    for (const cand of planned.candidates) {
      const live = await hasLiveRef(c, tenantId, cand.bucket, cand.key);
      if (live) {
        skipped_live.push(cand.key);
        continue;
      }
      // DeleteObject — 404 treated as success by store adapter
      await store.deleteObject({ bucket: cand.bucket, key: cand.key });
      deleted.push(cand.key);
    }
  });

  return {
    id,
    type: 'memory.object_gc.done',
    tenant_id: tenantId,
    occurred_at: new Date().toISOString(),
    payload: {
      status: 'ok',
      bucket: BUCKET,
      prefix: planned.prefix,
      grace_days: GRACE_DAYS,
      scanned: objects.length,
      candidates: planned.candidates.length,
      deleted,
      skipped_live,
      skipped_young: planned.skipped_young,
      skipped_prefix: planned.skipped_prefix,
    },
  };
}

async function objectGcHandler(context) {
  const host = process.env.AURA_DATABASE_HOST || '';
  if (host && !poolerHostOk(host)) {
    return {
      status: 500,
      body: JSON.stringify({
        error: 'invalid_database_host',
        detail: 'AURA_DATABASE_HOST must be aura-pg-pooler Service only',
      }),
    };
  }

  let envelope;
  try {
    envelope = parseBody(context && context.request);
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({ error: 'invalid_json', detail: String(err && err.message) }),
    };
  }

  const client = (context && context.pgClient) || {
    async query() {
      return { rows: [] };
    },
  };
  const objectStore = (context && context.objectStore) || {
    async listObjects() {
      return [];
    },
    async deleteObject() {
      return { ok: true };
    },
  };

  try {
    const out = await runObjectGcOnce(client, objectStore, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    const status = err.status || 500;
    return {
      status,
      body: JSON.stringify({
        error: err.code || err.message || 'object_gc_failed',
        type: 'memory.object_gc.error',
      }),
    };
  }
};


module.exports = objectGcHandler;
module.exports.runObjectGcOnce = runObjectGcOnce;
module.exports.hasLiveRef = hasLiveRef;
module.exports.planCandidates = planCandidates;
module.exports.idempotentTaskId = idempotentTaskId;
module.exports.poolerHostOk = poolerHostOk;
module.exports.withTenantTx = withTenantTx;
module.exports.GRACE_DAYS = GRACE_DAYS;
module.exports.BATCH_LIMIT = BATCH_LIMIT;
module.exports.BUCKET = BUCKET;
