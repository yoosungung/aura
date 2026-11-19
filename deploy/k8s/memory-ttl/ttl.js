'use strict';

/**
 * Fission Package entry for aura.tasks.memory.ttl (ARCHITECTURE §3.2 · §6.2.2).
 * Source of truth: services/memory/ttl/{partition-plan,handler}.js
 * Single-file literal for Fission Package (no require siblings).
 */

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


/**
 * Fission MQT handler — aura.tasks.memory.ttl (M4 monthly partition DROP).
 * short_term (14d) / audit (12mo): DROP when U <= now-hot.
 * episodic (24mo): needs_archive unless archived=true (archive task owns Parquet).
 *
 * Partition DROP is schema DDL (not tenant RLS). Soft-delete-only cleanup is forbidden.
 */

const SAFE_NAME =
  /^(memory_items_(?:short_term|episodic)_\d{4}_\d{2}|memory_audit_\d{4}_\d{2})$/;

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

function assertSafeName(name) {
  if (!SAFE_NAME.test(name)) {
    const err = new Error('partition_name_unsafe');
    err.code = 'partition_name_unsafe';
    err.status = 400;
    throw err;
  }
}

/**
 * @param {{ query: Function }} client
 * @param {object} envelope
 */
async function runTtlOnce(client, envelope) {
  const id = envelope && envelope.id;
  if (!id) {
    const err = new Error('id_required');
    err.status = 400;
    throw err;
  }

  const p = payloadOf(envelope);
  const partitions = Array.isArray(p.partitions) ? p.partitions : [];
  const now = p.now || new Date().toISOString();

  const normalized = partitions.map((part) => {
    assertSafeName(part.name);
    return {
      kind: part.kind,
      name: part.name,
      upperBoundExclusive: part.upper_bound || part.upperBoundExclusive,
      archived: Boolean(part.archived),
      now,
    };
  });

  const plans = planBatch(normalized, now);
  const dropped = [];
  const needs_archive = [];
  const kept = [];

  for (const plan of plans) {
    if (plan.action === 'keep') {
      kept.push(plan.name);
      continue;
    }
    if (plan.action === 'needs_archive') {
      needs_archive.push(plan.name);
      continue;
    }
    if (plan.action === 'drop') {
      assertSafeName(plan.name);
      // RESTRICT — no CASCADE automation (dependents must be reviewed).
      await client.query(
        `/* aura.tasks.memory.ttl */ DROP TABLE IF EXISTS ${plan.name} RESTRICT`
      );
      dropped.push(plan.name);
    }
  }

  return {
    id,
    type: 'memory.ttl.done',
    tenant_id: envelope.tenant_id || null,
    occurred_at: new Date().toISOString(),
    payload: {
      status: 'ok',
      hot: HOT,
      dropped,
      needs_archive,
      kept,
      plans,
    },
  };
}

async function ttlHandler(context) {
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

  try {
    const out = await runTtlOnce(client, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    const status = err.status || 500;
    return {
      status,
      body: JSON.stringify({
        error: err.code || err.message || 'ttl_failed',
        type: 'memory.ttl.error',
      }),
    };
  }
};

module.exports = ttlHandler;
module.exports.runTtlOnce = runTtlOnce;
module.exports.planPartitionAction = planPartitionAction;
module.exports.planBatch = planBatch;
module.exports.poolerHostOk = poolerHostOk;
module.exports.HOT = HOT;
