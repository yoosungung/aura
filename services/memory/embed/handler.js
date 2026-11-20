'use strict';

/**
 * Fission MQT handler — aura.tasks.memory.embed (M2).
 * short_term → skip (no PG). episodic/long_term/semantic → Gateway embeddings → Pooler stub.
 * Live vectors: LLM Gateway POST /v1/embeddings only (no TEI/Ollama direct).
 * HNSW = memory_embeddings (active model_key). BM25 = memory_items.content_tsv (store-side GENERATED).
 *
 * Non-goals (this slice): real halfvec INSERT · recall query auto-embed.
 */

const fs = require('fs');
const {
  assertFunctionLlmEgress,
} = require('../../llm-gateway/client');
const { withTenantTx } = require('../store/tenant-tx');

const EMBEDDABLE = new Set(['episodic', 'long_term', 'semantic']);
const DEFAULT_GATEWAY =
  'http://aura-llm-gateway.aura.svc.cluster.local:8080';
const LAB_CONFIG_DIR = '/configs/default/aura-memory-embed-lab';

function envOrLabConfig(name, fallback) {
  if (process.env[name] != null && process.env[name] !== '') {
    return process.env[name];
  }
  try {
    const p = `${LAB_CONFIG_DIR}/${name}`;
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch (_) {
    /* ignore */
  }
  return fallback;
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
  const model = envOrLabConfig('AURA_EMBEDDING_MODEL', 'BAAI/bge-m3');
  const version = envOrLabConfig('AURA_EMBEDDING_VERSION', '1');
  const dims = Number(envOrLabConfig('AURA_EMBEDDING_DIMS', '1024'));
  return {
    model,
    version,
    dims,
    model_key: `${model}:${version}`,
  };
}

function gatewayBaseUrl() {
  return String(envOrLabConfig('AURA_LLM_GATEWAY_URL', DEFAULT_GATEWAY)).replace(
    /\/$/,
    '',
  );
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

function contentOf(envelope) {
  const p = envelope && envelope.payload;
  if (p && p.content != null) return String(p.content);
  if (envelope && envelope.content != null) return String(envelope.content);
  return '';
}

/**
 * @param {{ tenant_id: string, model: string, input: string, fetchImpl?: Function }} opts
 */
async function fetchGatewayEmbedding(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const base = gatewayBaseUrl();
  assertFunctionLlmEgress(base);
  const fetchImpl =
    typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const err = new Error('embed_provider_error');
    err.status = 502;
    err.code = 'embed_provider_error';
    throw err;
  }
  let res;
  try {
    res = await fetchImpl(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aura-tenant-id': o.tenant_id,
      },
      body: JSON.stringify({
        model: o.model,
        input: o.input,
      }),
    });
  } catch (e) {
    const err = new Error('embed_provider_error');
    err.status = 502;
    err.code = 'embed_provider_error';
    err.cause = e;
    throw err;
  }
  if (!res || !res.ok) {
    const err = new Error('embed_provider_error');
    err.status = 502;
    err.code = 'embed_provider_error';
    throw err;
  }
  const body = await res.json();
  const embedding =
    body &&
    Array.isArray(body.data) &&
    body.data[0] &&
    Array.isArray(body.data[0].embedding)
      ? body.data[0].embedding
      : null;
  if (!embedding) {
    const err = new Error('embed_provider_error');
    err.status = 502;
    err.code = 'embed_provider_error';
    throw err;
  }
  return {
    embedding,
    usage: body.usage || null,
  };
}

/**
 * @param {{ query: Function }} client
 * @param {object} envelope
 * @param {{ fetchImpl?: Function }} [deps]
 */
async function embedOnce(client, envelope, deps) {
  const tenantId = envelope.tenant_id;
  const id = envelope.id;
  const memoryType = memoryTypeOf(envelope);
  const d = deps && typeof deps === 'object' ? deps : {};

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

  // App-level short_term refuse (DDL CHECK is SoR; do not attempt INSERT).
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

  const emb = await fetchGatewayEmbedding({
    tenant_id: tenantId,
    model: pin.model,
    input: contentOf(envelope),
    fetchImpl: d.fetchImpl,
  });
  if (emb.embedding.length !== pin.dims) {
    const err = new Error('embedding_dims_mismatch');
    err.status = 400;
    err.code = 'embedding_dims_mismatch';
    throw err;
  }

  return withTenantTx(client, tenantId, async (c) => {
    // Real UPSERT into memory_embeddings (halfvec) follows same helper + vector.
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
        status: 'accepted',
        memory_type: memoryType,
        item_id: itemId,
        model_key: pin.model_key,
        dims: pin.dims,
        via: 'llm_gateway',
        embedding_tokens:
          emb.usage && emb.usage.total_tokens != null
            ? Number(emb.usage.total_tokens)
            : undefined,
        // BM25 path = store-written content_tsv GIN; embed owns HNSW row only (UPSERT 후속).
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
    const out = await embedOnce(client, envelope, {
      fetchImpl: context && context.fetch,
    });
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    const status = err.status || 500;
    return {
      status,
      body: JSON.stringify({
        error: err.message || 'embed_failed',
        type: 'memory.embed.error',
      }),
    };
  }
};

module.exports.embedOnce = embedOnce;
module.exports.poolerHostOk = poolerHostOk;
module.exports.isEmbeddableType = isEmbeddableType;
module.exports.activePin = activePin;
module.exports.withTenantTx = withTenantTx;
module.exports.fetchGatewayEmbedding = fetchGatewayEmbedding;
module.exports.gatewayBaseUrl = gatewayBaseUrl;
