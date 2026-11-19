'use strict';

/**
 * Fission MQT handler — aura.tasks.memory.ttl (M4 monthly partition DROP).
 * short_term (14d) / audit (12mo): DROP when U <= now-hot.
 * episodic (24mo): needs_archive unless archived=true (archive task owns Parquet).
 *
 * Partition DROP is schema DDL (not tenant RLS). Soft-delete-only cleanup is forbidden.
 */

const { planPartitionAction, planBatch, HOT } = require('./partition-plan');

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

module.exports.runTtlOnce = runTtlOnce;
module.exports.planPartitionAction = planPartitionAction;
module.exports.planBatch = planBatch;
module.exports.poolerHostOk = poolerHostOk;
module.exports.HOT = HOT;
