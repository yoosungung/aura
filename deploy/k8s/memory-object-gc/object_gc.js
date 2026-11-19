'use strict';

/**
 * Fission Package entry for aura.tasks.memory.object_gc (ARCHITECTURE §3.2 · §8).
 * Source of truth: services/memory/object_gc/{plan,handler}.js + store/tenant-tx.js
 * Single-file literal for Fission Package (no require siblings).
 */

const GRACE_DAYS = 90;
const BATCH_LIMIT = 100;
const BUCKET = 'aura-content';

function refsPrefix(tenantId) {
  return `tenants/${tenantId}/refs/`;
}

function graceCutoff(now) {
  const n = new Date(now.getTime());
  n.setUTCDate(n.getUTCDate() - GRACE_DAYS);
  return n;
}

function isAllowedKey(key, tenantId) {
  if (!key || !tenantId) return false;
  const prefix = refsPrefix(tenantId);
  if (!key.startsWith(prefix)) return false;
  if (key.includes('/archive/') || key.includes('/bundles/')) return false;
  return true;
}

function filterCandidates(objects, opts) {
  if (!opts || !opts.tenantId) {
    const err = new Error('tenant_id_required');
    err.code = 'tenant_id_required';
    err.status = 400;
    throw err;
  }
  const now = opts.now != null ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    const err = new Error('timestamp_invalid');
    err.code = 'timestamp_invalid';
    err.status = 400;
    throw err;
  }
  const cutoff = graceCutoff(now);
  const limit = opts.limit != null ? Number(opts.limit) : BATCH_LIMIT;
  const out = [];
  const list = Array.isArray(objects) ? objects : [];
  for (const obj of list) {
    if (!obj || !isAllowedKey(obj.key, opts.tenantId)) continue;
    const lm = new Date(obj.lastModified || obj.LastModified);
    if (Number.isNaN(lm.getTime())) continue;
    if (lm.getTime() >= cutoff.getTime()) continue;
    out.push({
      key: obj.key,
      lastModified: lm.toISOString(),
      bucket: BUCKET,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function taskIdempotencyKey(tenantId, now) {
  const d = now != null ? new Date(now) : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `object-gc:${tenantId}:${yyyy}-${mm}-${dd}`;
}

async function withTenantTx(client, tenantId, fn) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenant_id_required');
  }
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
}

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

const LIVE_REF_SQL = `
SELECT 1 AS hit FROM (
  SELECT 1
  FROM memory_items
  WHERE tenant_id = $1
    AND metadata #>> '{content_ref,bucket}' = $2
    AND metadata #>> '{content_ref,key}' = $3
  LIMIT 1
  UNION ALL
  SELECT 1
  FROM memory_audit
  WHERE tenant_id = $1
    AND metadata #>> '{content_ref,bucket}' = $2
    AND metadata #>> '{content_ref,key}' = $3
  LIMIT 1
) t
LIMIT 1`;

async function liveRefExists(client, tenantId, bucket, key) {
  const r = await client.query(LIVE_REF_SQL, [tenantId, bucket, key]);
  return Boolean(r && r.rows && r.rows.length > 0);
}

function isNotFound(err) {
  if (!err) return false;
  if (err.status === 404 || err.$metadata?.httpStatusCode === 404) return true;
  const code = String(err.code || err.name || '');
  return /NotFound|NoSuchKey|404/i.test(code) || /NotFound|NoSuchKey/i.test(String(err.message || ''));
}

async function runObjectGcOnce(client, objectStore, envelope) {
  const id = envelope && envelope.id;
  const tenantId = envelope && envelope.tenant_id;
  if (!id) {
    const err = new Error('id_required');
    err.status = 400;
    throw err;
  }
  if (!tenantId) {
    const err = new Error('tenant_id_required');
    err.status = 400;
    throw err;
  }

  const p = payloadOf(envelope);
  const now = p.now || new Date().toISOString();
  const store = objectStore || {};
  if (typeof store.listObjects !== 'function') {
    const err = new Error('object_store_required');
    err.code = 'object_store_required';
    err.status = 500;
    throw err;
  }
  if (typeof store.deleteObject !== 'function') {
    const err = new Error('object_store_required');
    err.code = 'object_store_required';
    err.status = 500;
    throw err;
  }

  const prefix = refsPrefix(tenantId);
  const listed = await store.listObjects({ bucket: BUCKET, prefix });
  const objects = (listed && listed.objects) || [];
  const candidates = filterCandidates(objects, { tenantId, now });

  const deleted = [];
  const skipped = [];

  await withTenantTx(client, tenantId, async (tx) => {
    for (const cand of candidates) {
      const live = await liveRefExists(tx, tenantId, cand.bucket, cand.key);
      if (live) {
        skipped.push({ key: cand.key, reason: 'live_ref' });
        continue;
      }
      try {
        await store.deleteObject({ bucket: cand.bucket, key: cand.key });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      deleted.push({ key: cand.key, bucket: cand.bucket });
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
      prefix,
      grace_days: GRACE_DAYS,
      batch_limit: BATCH_LIMIT,
      idempotency_key: taskIdempotencyKey(tenantId, now),
      scanned: candidates.length,
      deleted,
      skipped,
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
      return { objects: [] };
    },
    async deleteObject() {
      return { deleted: true };
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
}

module.exports = objectGcHandler;
module.exports.runObjectGcOnce = runObjectGcOnce;
module.exports.liveRefExists = liveRefExists;
module.exports.poolerHostOk = poolerHostOk;
module.exports.filterCandidates = filterCandidates;
module.exports.refsPrefix = refsPrefix;
module.exports.BUCKET = BUCKET;
module.exports.GRACE_DAYS = GRACE_DAYS;
module.exports.BATCH_LIMIT = BATCH_LIMIT;
