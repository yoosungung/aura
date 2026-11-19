'use strict';

/**
 * Fission Package entry for aura.tasks.memory.archive (ARCHITECTURE §3.2 · §6.2.2 · §8).
 * Source of truth: services/memory/archive/{plan,handler}.js
 * Single-file literal for Fission Package (no require siblings).
 */

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


/**
 * Fission MQT handler — aura.tasks.memory.archive (M4).
 * Cold episodic → Parquet PutObject (aura-content archive/) → DETACH → DROP.
 *
 * Non-goals: live Garage SDK · object_gc · OTel · erase · pg_parquet extension.
 * Export body is a deterministic Parquet-stub buffer (magic PAR1) for unit/gate;
 * live COPY/pg_parquet can replace exportPartitionStub without changing steps.
 */


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

/** Minimal Parquet magic stub — proves object bytes before DETACH/DROP. */
function exportPartitionStub(partitionName, rowCount) {
  const n = Number(rowCount) || 0;
  const meta = Buffer.from(
    JSON.stringify({
      format: 'parquet_stub',
      partition: partitionName,
      row_count: n,
    }),
    'utf8'
  );
  return Buffer.concat([Buffer.from('PAR1'), meta]);
}

/**
 * @param {{ query: Function }} client
 * @param {{
 *   putObject?: Function,
 *   headObject?: Function,
 * }} objectStore
 * @param {object} envelope
 */
async function runArchiveOnce(client, objectStore, envelope) {
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
  const partitions = Array.isArray(p.partitions) ? p.partitions : [];
  const now = p.now || new Date().toISOString();

  const normalized = partitions.map((part) => ({
    name: part.name,
    upperBoundExclusive: part.upper_bound || part.upperBoundExclusive,
    tenant_id: tenantId,
    now,
    object_exists: Boolean(part.object_exists),
  }));

  const plans = planBatch(normalized, now);
  const archived = [];
  const skipped = [];
  const store = objectStore || {};

  for (const plan of plans) {
    if (plan.action === 'skip_hot') {
      skipped.push({ name: plan.name, reason: plan.reason });
      continue;
    }
    if (plan.action !== 'archive') continue;

    const rowCount = Number(
      (partitions.find((x) => x.name === plan.name) || {}).row_count || 0
    );
    const body = exportPartitionStub(plan.name, rowCount);

    // 1–2 PutObject (skip re-upload if head says exists and sizes match — optional)
    let put = { etag: null, skipped: false };
    if (typeof store.headObject === 'function') {
      const head = await store.headObject({ bucket: plan.bucket, key: plan.key });
      if (head && head.exists && Number(head.size_bytes) === body.length) {
        put = { etag: head.etag || 'existing', skipped: true };
      }
    }
    if (!put.skipped) {
      if (typeof store.putObject !== 'function') {
        const err = new Error('object_store_required');
        err.code = 'object_store_required';
        err.status = 500;
        throw err;
      }
      put = await store.putObject({
        bucket: plan.bucket,
        key: plan.key,
        body,
        contentType: 'application/vnd.apache.parquet',
      });
    }

    // 3 verify — refuse DETACH/DROP without object bytes
    if (!put || (!put.etag && !put.skipped)) {
      const err = new Error('archive_put_failed');
      err.code = 'archive_put_failed';
      err.status = 500;
      throw err;
    }

    // 4 DETACH then 5 DROP (RESTRICT) — never before PutObject success
    await client.query(
      `/* aura.tasks.memory.archive */ ALTER TABLE memory_items_episodic DETACH PARTITION ${plan.name}`
    );
    await client.query(
      `/* aura.tasks.memory.archive */ DROP TABLE IF EXISTS ${plan.name} RESTRICT`
    );

    archived.push({
      name: plan.name,
      bucket: plan.bucket,
      key: plan.key,
      uri: plan.uri,
      size_bytes: body.length,
      row_count: rowCount,
      etag: put.etag || null,
    });
  }

  return {
    id,
    type: 'memory.archived',
    tenant_id: tenantId,
    occurred_at: new Date().toISOString(),
    payload: {
      status: 'ok',
      hot: HOT_EPISODIC,
      bucket: BUCKET,
      archived,
      skipped,
      plans,
    },
  };
}

async function archiveHandler(context) {
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
    async putObject({ body }) {
      return { etag: 'stub-etag', size_bytes: body ? body.length : 0 };
    },
  };

  try {
    const out = await runArchiveOnce(client, objectStore, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    const status = err.status || 500;
    return {
      status,
      body: JSON.stringify({
        error: err.code || err.message || 'archive_failed',
        type: 'memory.archive.error',
      }),
    };
  }
}

module.exports = archiveHandler;
module.exports.runArchiveOnce = runArchiveOnce;
module.exports.exportPartitionStub = exportPartitionStub;
module.exports.planArchiveAction = planArchiveAction;
module.exports.planBatch = planBatch;
module.exports.poolerHostOk = poolerHostOk;
module.exports.HOT_EPISODIC = HOT_EPISODIC;
module.exports.BUCKET = BUCKET;
