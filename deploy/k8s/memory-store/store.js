'use strict';

/**
 * Fission Package entry for aura.tasks.memory.store (ARCHITECTURE §3.2 · §2.1).
 * Source of truth for unit tests: services/memory/store/{tenant-tx,handler}.js
 * This file is a single-file literal for Fission Package (no require siblings).
 */

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
    const out = await storeOnce(client, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.message || 'store_failed',
        type: 'memory.store.error',
      }),
    };
  }
};
