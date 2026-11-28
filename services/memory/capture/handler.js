'use strict';

/**
 * Fission MQT handler — aura.tasks.memory.capture (ARCHITECTURE §1 #10 · §3.2 · §5).
 * PG read/write forbidden. Success body → respTopic aura.events.memory.candidates.
 *
 * Non-goals (M2 slice): live LLM Gateway HTTP · content_ref object upload · store/embed.
 */

function parseBody(req) {
  let raw = (req && req.body) != null ? req.body : '';
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/**
 * Deterministic M2 extractor (no LLM). Production will inject Gateway-backed extract.
 * Tags short_term by default; episodic when payload.kind === 'episodic'.
 * @param {object} payload
 * @returns {Promise<Array<{memory_type: string, content: string, session_id?: string}>>}
 */
async function defaultExtractCandidates(payload) {
  const p = payload || {};
  const text =
    typeof p.text === 'string'
      ? p.text
      : Array.isArray(p.messages)
        ? p.messages
            .map((m) => (m && typeof m.content === 'string' ? m.content : ''))
            .filter(Boolean)
            .join('\n')
        : '';
  if (!text.trim()) return [];
  const memoryType = p.kind === 'episodic' ? 'episodic' : 'short_term';
  const item = { memory_type: memoryType, content: text.trim() };
  if (p.session_id) item.session_id = p.session_id;
  return [item];
}

/**
 * @param {object} envelope
 * @param {(payload: object) => Promise<object[]>} extractCandidates
 */
async function captureOnce(envelope, extractCandidates) {
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

  const candidates = await extractCandidates(envelope.payload || {});
  for (const c of candidates) {
    if (!c || (c.memory_type !== 'short_term' && c.memory_type !== 'episodic')) {
      const err = new Error('invalid_candidate_memory_type');
      err.status = 500;
      throw err;
    }
  }

  return {
    id,
    type: 'memory.candidates',
    tenant_id: tenantId,
    occurred_at: new Date().toISOString(),
    payload: { candidates },
    content_ref: null,
  };
}

module.exports = async function (context) {
  let envelope;
  try {
    envelope = parseBody(context && context.request);
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({
        error: 'invalid_json',
        detail: String(err && err.message),
        type: 'memory.capture.error',
      }),
    };
  }

  const extract =
    (context && context.extractCandidates) || defaultExtractCandidates;

  try {
    const out = await captureOnce(envelope, extract);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.message || 'capture_failed',
        type: 'memory.capture.error',
      }),
    };
  }
};

module.exports.captureOnce = captureOnce;
module.exports.defaultExtractCandidates = defaultExtractCandidates;
