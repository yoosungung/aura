'use strict';

/**
 * Fission Package entry for aura.tasks.memory.embed (ARCHITECTURE §3.2 · §2.1 · §6.2.1).
 * Source of truth for unit tests: services/memory/embed/handler.js + store/tenant-tx.js
 * This file is a single-file literal for Fission Package (no require siblings).
 */

const EMBEDDABLE = new Set(['episodic', 'long_term', 'semantic']);

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

function isEmbeddableType(memoryType) {
  return EMBEDDABLE.has(memoryType);
}

function activePin() {
  const model = process.env.AURA_EMBEDDING_MODEL || 'BAAI/bge-m3';
  const version = process.env.AURA_EMBEDDING_VERSION || '1';
  const dims = Number(process.env.AURA_EMBEDDING_DIMS || '1024');
  return {
    model,
    version,
    dims,
    model_key: `${model}:${version}`,
  };
}

function parseBody(req) {
  let raw = (req && req.body) != null ? req.body : '';
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function memoryTypeOf(envelope) {
  const p = envelope && envelope.payload;
  if (p && typeof p.memory_type === 'string') return p.memory_type;
  if (typeof envelope.memory_type === 'string') return envelope.memory_type;
  return null;
}

async function embedOnce(client, envelope) {
  const tenantId = envelope.tenant_id;
  const id = envelope.id;
  const memoryType = memoryTypeOf(envelope);

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
  if (!memoryType) {
    const err = new Error('memory_type_required');
    err.status = 400;
    throw err;
  }

  if (memoryType === 'short_term') {
    return {
      id,
      type: 'memory.embedded',
      tenant_id: tenantId,
      occurred_at: new Date().toISOString(),
      payload: {
        status: 'skipped_short_term',
        memory_type: 'short_term',
        indexes: { hnsw: false, bm25: false },
      },
    };
  }

  if (!isEmbeddableType(memoryType)) {
    const err = new Error('memory_type_not_embeddable');
    err.status = 400;
    throw err;
  }

  const pin = activePin();
  const itemId =
    (envelope.payload && envelope.payload.item_id) ||
    envelope.item_id ||
    id;

  return withTenantTx(client, tenantId, async (c) => {
    await c.query(
      '/* aura.tasks.memory.embed idempotent stub */ SELECT $1::text AS event_id, $2::text AS item_id, $3::text AS memory_type, $4::text AS model_key, current_setting($5, true) AS tenant_guc',
      [id, itemId, memoryType, pin.model_key, 'app.tenant_id']
    );
    return {
      id,
      type: 'memory.embedded',
      tenant_id: tenantId,
      occurred_at: new Date().toISOString(),
      payload: {
        status: 'accepted_stub',
        memory_type: memoryType,
        item_id: itemId,
        model_key: pin.model_key,
        dims: pin.dims,
        indexes: { hnsw: true, bm25: true },
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
    const out = await embedOnce(client, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.message || 'embed_failed',
        type: 'memory.embed.error',
      }),
    };
  }
};
