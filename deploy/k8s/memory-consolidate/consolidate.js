'use strict';

/**
 * Fission Package entry for aura.tasks.memory.consolidate (ARCHITECTURE §3.2 · §5).
 * Source of truth: services/memory/consolidate/{promote,handler}.js + store/tenant-tx.js
 * Single-file literal for Fission Package (no require siblings).
 */

const ALLOWED_TRANSITIONS = new Set([
  'short_term->episodic',
  'episodic->long_term',
  'episodic->semantic',
]);

const VALID_REASONS = new Set([
  'session_boundary',
  'recurrence',
  'llm_extract',
  'operator',
]);

const RECURRENCE_MIN_EVIDENCE = 3;

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

function fail(code) {
  const err = new Error(code);
  err.code = code;
  err.status = 400;
  throw err;
}

function isAllowedTransition(fromType, toType) {
  return ALLOWED_TRANSITIONS.has(`${fromType}->${toType}`);
}

function planPromotion(input) {
  if (!input || !input.item_id || !input.created_at) {
    fail('item_identity_required');
  }
  if (!input.from_type || !input.to_type) {
    fail('types_required');
  }
  const reason = input.reason;
  if (!reason) {
    fail('reason_required');
  }
  if (reason === 'similarity_only') {
    fail('similarity_only_forbidden');
  }
  if (!VALID_REASONS.has(reason)) {
    fail('reason_invalid');
  }
  if (!isAllowedTransition(input.from_type, input.to_type)) {
    fail('transition_not_allowed');
  }
  if (reason === 'recurrence') {
    const n = Number(input.evidence_count);
    if (!Number.isFinite(n) || n < RECURRENCE_MIN_EVIDENCE) {
      fail('recurrence_below_threshold');
    }
  }
  return {
    ok: true,
    from_type: input.from_type,
    to_type: input.to_type,
    reason,
    ops: [
      {
        op: 'soft_close',
        item_id: input.item_id,
        memory_type: input.from_type,
        created_at: input.created_at,
      },
      {
        op: 'insert_promoted',
        memory_type: input.to_type,
        supersedes_id: input.item_id,
        source_created_at: input.created_at,
      },
    ],
  };
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
