'use strict';

/**
 * Core Request-Reply handler — aura.rpc.memory.recall (M2 hybrid RRF + M4 graph walk).
 *
 * short_term = session recent (no HNSW).
 * episodic/long_term/semantic = BM25 + vector RRF (+ defensive graph 1–2 hop).
 * Pooler + set_config(..., true) + SET LOCAL iterative_scan/ef_search.
 *
 * Non-goals: live TEI HTTP · Agent prompt inject · live apply · unbounded recursive CTE.
 */

const { withTenantTx } = require('../store/tenant-tx');
const { walkGraph, GRAPH_LIMITS } = require('./graph-walk');

const SUBJECT = 'aura.rpc.memory.recall';
const RRF_K = 60;
const SHORT_TERM_BUDGET_DEFAULT = 4;
const ANN_WINDOW = 40;

const EMBEDDABLE = new Set(['episodic', 'long_term', 'semantic']);

function poolerHostOk(host) {
  if (!host) return false;
  if (!host.includes('aura-pg-pooler')) return false;
  if (/(^|[.-])aura-pg-rw($|[.-])|aura-pg-r($|[.-])|aura-pg-ro($|[.-])/.test(host)) {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return true;
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

function parseRequest(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  text = text.trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Reciprocal Rank Fusion over ranked id lists.
 * score += weight / (k + rank); rank starts at 1.
 *
 * @param {Array<Array<{id: string}>>} lists
 * @param {{ k?: number, weights?: number[] }} [opts]
 */
function fuseRrf(lists, opts) {
  const k = (opts && opts.k) != null ? opts.k : RRF_K;
  const weights = (opts && opts.weights) || [];
  const scores = new Map();
  lists.forEach((list, li) => {
    const w = weights[li] != null ? weights[li] : 1;
    (list || []).forEach((item, idx) => {
      if (!item || item.id == null) return;
      const id = String(item.id);
      const rank = idx + 1;
      const prev = scores.get(id) || { id, score: 0, item: {} };
      prev.score += w / (k + rank);
      prev.item = { ...prev.item, ...item, id };
      scores.set(id, prev);
    });
  });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .map((x) => ({ ...x.item, rrf_score: x.score }));
}

function normalizeTypes(types) {
  if (!Array.isArray(types) || types.length === 0) {
    return ['short_term', 'episodic', 'long_term', 'semantic'];
  }
  return types.filter((t) => typeof t === 'string');
}

function formatHalfvecLiteral(arr) {
  return `[${arr.map((n) => Number(n)).join(',')}]`;
}

async function applyHnswLocals(client) {
  await client.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
  await client.query('SET LOCAL hnsw.ef_search = 40');
  await client.query('SET LOCAL hnsw.max_scan_tuples = 20000');
}

/**
 * @param {{ query: Function }} client
 * @param {object} req
 */
async function selectShortTerm(client, req, budget) {
  const types = normalizeTypes(req.types);
  if (!types.includes('short_term') || budget <= 0) return [];

  const params = [req.tenant_id, budget];
  let sessionClause = '';
  if (req.session_id) {
    params.push(req.session_id);
    sessionClause = ` AND session_id = $${params.length}`;
  }

  const sql = `
SELECT id::text AS id, memory_type::text AS memory_type, content, created_at, session_id, principal_id
FROM memory_items
WHERE tenant_id = $1::uuid
  AND memory_type = 'short_term'
  AND (valid_until IS NULL OR valid_until > now())
  ${sessionClause}
ORDER BY created_at DESC
LIMIT $2`;

  const res = await client.query(sql, params);
  return (res.rows || []).map((row, idx) => ({
    ...row,
    source: 'short_term_recent',
    rank: idx + 1,
  }));
}

/**
 * @param {{ query: Function }} client
 * @param {object} req
 * @param {string[]} embedTypes
 */
async function selectBm25(client, req, embedTypes, window) {
  if (embedTypes.length === 0 || window <= 0) return [];
  const sql = `
SELECT id::text AS id, memory_type::text AS memory_type, content,
       ts_rank(content_tsv, plainto_tsquery('simple', $2)) AS score
FROM memory_items
WHERE tenant_id = $1::uuid
  AND memory_type = ANY($3::memory_type[])
  AND (valid_until IS NULL OR valid_until > now())
  AND content_tsv @@ plainto_tsquery('simple', $2)
ORDER BY score DESC, created_at DESC
LIMIT $4`;
  const res = await client.query(sql, [req.tenant_id, String(req.query), embedTypes, window]);
  return (res.rows || []).map((row, idx) => ({
    ...row,
    source: 'bm25',
    rank: idx + 1,
  }));
}

/**
 * @param {{ query: Function }} client
 * @param {object} req
 * @param {string[]} embedTypes
 * @param {{ model_key: string, dims: number }} pin
 */
async function selectVector(client, req, embedTypes, pin, window) {
  if (embedTypes.length === 0 || window <= 0) return [];
  if (!Array.isArray(req.query_embedding) || req.query_embedding.length === 0) return [];

  const lit = formatHalfvecLiteral(req.query_embedding);
  const sql = `
SELECT e.item_id::text AS id, e.memory_type::text AS memory_type, i.content,
       (e.embedding::halfvec(${pin.dims})) <=> $2::halfvec AS dist
FROM memory_embeddings e
JOIN memory_items i
  ON i.id = e.item_id AND i.memory_type = e.memory_type AND i.tenant_id = e.tenant_id
WHERE e.tenant_id = $1::uuid
  AND e.model_key = $3
  AND e.memory_type = ANY($4::memory_type[])
  AND (i.valid_until IS NULL OR i.valid_until > now())
ORDER BY (e.embedding::halfvec(${pin.dims})) <=> $2::halfvec
LIMIT $5`;

  const res = await client.query(sql, [
    req.tenant_id,
    lit,
    pin.model_key,
    embedTypes,
    window,
  ]);
  return (res.rows || []).map((row, idx) => ({
    ...row,
    source: 'vector',
    rank: idx + 1,
  }));
}

/**
 * Seed graph walk from BM25/vector hit item ids (ARCHITECTURE §6.2.4).
 * @param {{ query: Function }} client
 * @param {string} tenantId
 * @param {Array<{ id: string }>} bm25
 * @param {Array<{ id: string }>} vector
 */
async function runGraphWalk(client, tenantId, bm25, vector) {
  const seedIds = [
    ...new Set(
      [...(bm25 || []), ...(vector || [])]
        .map((x) => (x && x.id != null ? String(x.id) : null))
        .filter(Boolean)
    ),
  ];
  if (seedIds.length === 0) {
    return {
      mode: 'walk',
      candidates: [],
      stats: {
        depth_reached: 0,
        nodes_total: 0,
        edges_read: 0,
        truncated: false,
        seed_nodes: 0,
      },
      limits: GRAPH_LIMITS,
    };
  }
  const walked = await walkGraph(client, {
    tenant_id: tenantId,
    seed_item_ids: seedIds,
  });
  return { ...walked, limits: GRAPH_LIMITS };
}

function applyTypeBudgets(shortItems, hybridItems, topK) {
  const shortBudget = Math.min(SHORT_TERM_BUDGET_DEFAULT, topK);
  const short = (shortItems || []).slice(0, shortBudget);
  const remain = Math.max(0, topK - short.length);
  const hybrid = (hybridItems || []).slice(0, remain);
  // Prefer short_term block first, then RRF order (episodic / long_term+semantic mixed by score).
  return [...short, ...hybrid];
}

/**
 * @param {object} request §6.3 envelope (+ optional query_embedding)
 * @param {{ pgClient?: { query: Function } }} [opts]
 * @returns {Promise<{ status: number, body: string }>}
 */
async function recallOnce(request, opts) {
  const req = request && typeof request === 'object' ? request : {};
  const tenantId = req.tenant_id;
  const query = req.query;

  if (!tenantId) {
    return {
      status: 400,
      body: JSON.stringify({ error: 'tenant_id_required', subject: SUBJECT }),
    };
  }
  if (query == null || String(query).trim() === '') {
    return {
      status: 400,
      body: JSON.stringify({ error: 'query_required', subject: SUBJECT }),
    };
  }

  const topK = req.top_k != null ? Number(req.top_k) : 12;
  const types = normalizeTypes(req.types);
  const embedTypes = types.filter((t) => EMBEDDABLE.has(t));
  const pin = activePin();
  const client =
    (opts && opts.pgClient) ||
    {
      async query() {
        return { rows: [] };
      },
    };

  try {
    const result = await withTenantTx(client, tenantId, async (c) => {
      await applyHnswLocals(c);
      const shortItems = await selectShortTerm(c, req, Math.min(SHORT_TERM_BUDGET_DEFAULT, topK));
      const bm25 = await selectBm25(c, req, embedTypes, ANN_WINDOW);
      const vector = await selectVector(c, req, embedTypes, pin, ANN_WINDOW);
      const graph = await runGraphWalk(c, tenantId, bm25, vector);
      const hybrid = fuseRrf([bm25, vector, graph.candidates], {
        k: RRF_K,
        weights: [1, 1, 0.5],
      });
      const items = applyTypeBudgets(shortItems, hybrid, topK);
      return { items, graph, bm25_n: bm25.length, vector_n: vector.length };
    });

    return {
      status: 200,
      body: JSON.stringify({
        type: 'memory.recall.done',
        subject: SUBJECT,
        deploy_class: 'sync',
        mode: 'hybrid_rrf',
        tenant_id: tenantId,
        principal_id: req.principal_id || null,
        session_id: req.session_id || null,
        query: String(query),
        types,
        top_k: topK,
        model_key: pin.model_key,
        dims: pin.dims,
        rrf: { k: RRF_K, branches: ['bm25', 'vector', 'graph'] },
        graph: result.graph,
        items: result.items,
      }),
    };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.message || 'recall_failed',
        type: 'memory.recall.error',
        subject: SUBJECT,
      }),
    };
  }
}

module.exports = {
  SUBJECT,
  RRF_K,
  parseRequest,
  fuseRrf,
  poolerHostOk,
  activePin,
  recallOnce,
  runGraphWalk,
  withTenantTx,
  // Fission HTTP specialize placeholder (Warm Pool Function); Core RR is Deployment.
  handler: async function fissionWarmRecall(context) {
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
    const raw =
      context && context.request && context.request.body != null
        ? context.request.body
        : '';
    let req;
    try {
      req = parseRequest(raw);
    } catch (err) {
      return {
        status: 400,
        body: JSON.stringify({ error: 'invalid_json', message: String(err.message || err) }),
      };
    }
    const pgClient = context && context.pgClient;
    return recallOnce(req, pgClient ? { pgClient } : undefined);
  },
};
