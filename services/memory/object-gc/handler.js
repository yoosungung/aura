'use strict';

/**
 * Fission MQT handler — aura.tasks.memory.object_gc (M4).
 * List refs/ older than 90d → skip if live PG content_ref → DeleteObject.
 *
 * Non-goals: live Garage provision · archive/bundles GC · erase · OTel.
 */

const { withTenantTx } = require('../store/tenant-tx');
const {
  planCandidates,
  idempotentTaskId,
  GRACE_DAYS,
  BATCH_LIMIT,
  BUCKET,
  refsPrefix,
} = require('./plan');

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

module.exports = async function (context) {
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

module.exports.runObjectGcOnce = runObjectGcOnce;
module.exports.hasLiveRef = hasLiveRef;
module.exports.planCandidates = planCandidates;
module.exports.idempotentTaskId = idempotentTaskId;
module.exports.poolerHostOk = poolerHostOk;
module.exports.LIVE_REF_SQL = LIVE_REF_SQL;
module.exports.GRACE_DAYS = GRACE_DAYS;
module.exports.BATCH_LIMIT = BATCH_LIMIT;
module.exports.BUCKET = BUCKET;
