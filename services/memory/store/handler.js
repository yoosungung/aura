'use strict';

/**
 * Fission MQT handler — aura.tasks.memory.store (M1 skeleton).
 * PG only via Pooler: AURA_DATABASE_HOST must be aura-pg-pooler… (§2.1).
 * Every write path goes through withTenantTx → set_config(..., true).
 *
 * Non-goals (M1): real pg Pool client wiring in-cluster · embed/recall · full idempotent DDL.
 * Live INSERT lands on the same withTenantTx helper in a follow-up when pg driver is packaged.
 */

const { withTenantTx } = require('./tenant-tx');

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

/**
 * @param {{ query: Function }} client  injectable (tests / future pg Pool)
 * @param {object} envelope
 */
async function storeOnce(client, envelope) {
  const tenantId = envelope.tenant_id;
  const id = envelope.id;
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

  return withTenantTx(client, tenantId, async (c) => {
    // M1: record intent under tenant GUC. Real UPSERT on memory_items follows same helper.
    await c.query(
      '/* aura.tasks.memory.store idempotent stub */ SELECT $1::text AS event_id, current_setting($2, true) AS tenant_guc',
      [id, 'app.tenant_id']
    );
    return {
      id,
      type: 'memory.stored',
      tenant_id: tenantId,
      occurred_at: new Date().toISOString(),
      payload: { status: 'accepted_stub' },
    };
  });
}

module.exports = async function (context) {
  const host = process.env.AURA_DATABASE_HOST || '';
  // Contract check even when client is stubbed (MQT smoke before full pg package).
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

  // Injectable stub client for M1 static path — replaced by pg Pool(pooler DSN) when packaged.
  const client = (context && context.pgClient) || {
    async query() {
      return { rows: [] };
    },
  };

  try {
    const out = await storeOnce(client, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    const status = err.status || 500;
    return {
      status,
      body: JSON.stringify({
        error: err.message || 'store_failed',
        type: 'memory.store.error',
      }),
    };
  }
};

module.exports.storeOnce = storeOnce;
module.exports.poolerHostOk = poolerHostOk;
module.exports.withTenantTx = withTenantTx;
