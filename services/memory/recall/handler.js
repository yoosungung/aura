'use strict';

/**
 * Core Request-Reply handler — aura.rpc.memory.recall (M2 deploy slice).
 *
 * Warm Pool + queue-group HA. No JetStream MQT / lag scaler.
 * This slice locks the sync deploy contract; hybrid RRF / iterative_scan SQL
 * live on sibling ticket (short_term recent + RRF).
 *
 * Non-goals: hybrid RRF · graph walk · live Pooler SELECT · Agent prompt inject.
 */

const SUBJECT = 'aura.rpc.memory.recall';

function parseRequest(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  text = text.trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * @param {object} request §6.3 envelope
 * @param {{ pgClient?: { query: Function } }} [_opts] reserved; unused in stub slice
 * @returns {{ status: number, body: string }}
 */
function recallOnce(request, _opts) {
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

  // Stub: empty items. Sibling implements short_term recent + hybrid RRF.
  return {
    status: 200,
    body: JSON.stringify({
      type: 'memory.recall.done',
      subject: SUBJECT,
      deploy_class: 'sync',
      mode: 'stub',
      tenant_id: tenantId,
      principal_id: req.principal_id || null,
      session_id: req.session_id || null,
      query: String(query),
      types: Array.isArray(req.types) ? req.types : null,
      top_k: req.top_k != null ? Number(req.top_k) : 12,
      items: [],
    }),
  };
}

module.exports = {
  SUBJECT,
  parseRequest,
  recallOnce,
  // Fission HTTP specialize placeholder (Warm Pool Function); Core RR is Deployment.
  handler: async function fissionWarmStub(context) {
    const raw =
      context && context.request && context.request.body != null
        ? context.request.body
        : '';
    let req;
    try {
      req = parseRequest(raw);
    } catch (err) {
      return { status: 400, body: JSON.stringify({ error: 'invalid_json', message: String(err.message || err) }) };
    }
    return recallOnce(req);
  },
};
