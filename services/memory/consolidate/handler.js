'use strict';

/**
 * Fission MQT handler — aura.tasks.memory.consolidate (M4 type-promotion rules).
 * Only this path may change memory_type. Similarity alone is rejected.
 * LIST partition: soft_close + insert_promoted (never UPDATE memory_type).
 *
 * Non-goals (this slice): live LLM extract · graph node write · real UPSERT body · TTL/archive.
 */

const { withTenantTx } = require('../store/tenant-tx');
const { planPromotion } = require('./promote');

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

/**
 * @param {{ query: Function }} client
 * @param {object} envelope
 */
async function consolidateOnce(client, envelope) {
  const tenantId = envelope.tenant_id;
  const id = envelope.id;
  const p = payloadOf(envelope);

  if (!tenantId) {
    const err = new Error('tenant_id_required');
    err.status = 400;
    throw err;
  }
  if (!id) {
    const err = new Error('id_required');
    err.status = 400;
    throw err;
  }

  const plan = planPromotion({
    from_type: p.from_type,
    to_type: p.to_type,
    reason: p.reason,
    similarity: p.similarity,
    evidence_count: p.evidence_count,
    item_id: p.item_id,
    created_at: p.created_at,
  });

  return withTenantTx(client, tenantId, async (c) => {
    // M4 stub: record promote intent under tenant GUC. Real soft_close + INSERT follows same helper.
    await c.query(
      '/* aura.tasks.memory.consolidate soft_close+insert_promoted stub */ SELECT $1::text AS event_id, $2::text AS from_type, $3::text AS to_type, $4::text AS reason, current_setting($5, true) AS tenant_guc',
      [id, plan.from_type, plan.to_type, plan.reason, 'app.tenant_id']
    );
    return {
      id,
      type: 'memory.consolidated',
      tenant_id: tenantId,
      occurred_at: new Date().toISOString(),
      payload: {
        status: 'accepted_stub',
        from_type: plan.from_type,
        to_type: plan.to_type,
        reason: plan.reason,
        ops: plan.ops.map((o) => o.op),
      },
    };
  });
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
    const out = await consolidateOnce(client, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    const status = err.status || 500;
    return {
      status,
      body: JSON.stringify({
        error: err.code || err.message || 'consolidate_failed',
        type: 'memory.consolidate.error',
      }),
    };
  }
};

module.exports.consolidateOnce = consolidateOnce;
module.exports.planPromotion = planPromotion;
module.exports.poolerHostOk = poolerHostOk;
module.exports.withTenantTx = withTenantTx;
