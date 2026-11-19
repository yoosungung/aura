'use strict';

/**
 * AURA_DLQ Replay planner — ops-only reprocess of Term-path dead letters (§3.2 · §9.7).
 * Non-goals: Advisory 이관 · 자동 cron/무한 replay · live NATS publish (CLI wraps nats).
 */

const DLQ_STREAM = 'AURA_DLQ';
const DLQ_SUBJECT_PREFIX = 'aura.dlq.';
const DEFAULT_MAX_BATCH = 20;
const PATH_TERM = 'term';

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  e.status = 400;
  return e;
}

function assertSafeSrc(src) {
  if (src == null || src === '') {
    throw err('src_required', 'DLQ envelope requires src (original subject)');
  }
  if (typeof src !== 'string') {
    throw err('src_invalid', 'src must be a string subject');
  }
  if (src.startsWith(DLQ_SUBJECT_PREFIX) || src === 'aura.dlq.>') {
    throw err('src_is_dlq', 'refuse replay target under aura.dlq.* (no auto-loop)');
  }
}

/**
 * Parse path-① Term DLQ envelope.
 * Body shape (smoke-dlq-term): { id, src, tries, path:"term", echo|payload, error? }
 *
 * @param {string|object|Buffer} raw
 */
function parseDlqEnvelope(raw) {
  let obj = raw;
  if (Buffer.isBuffer(raw)) {
    obj = raw.toString('utf8');
  }
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw err('envelope_invalid', 'DLQ body must be JSON');
    }
  }
  if (!obj || typeof obj !== 'object') {
    throw err('envelope_invalid', 'DLQ body must be an object');
  }

  const src = obj.src;
  assertSafeSrc(src);

  let payload = obj.echo != null ? obj.echo : obj.payload;
  if (payload === undefined) {
    // Allow empty object payload only when echo/payload keys absent? Prefer explicit.
    throw err('payload_required', 'DLQ envelope requires echo or payload');
  }

  const path = obj.path != null ? String(obj.path) : PATH_TERM;
  return {
    id: obj.id != null ? String(obj.id) : null,
    src: String(src),
    tries: obj.tries != null ? Number(obj.tries) : null,
    path,
    payload,
    error: obj.error != null ? obj.error : null,
    raw: obj,
  };
}

/**
 * Build a single JetStream/Core publish for replay (subject = original src).
 * @param {{ src: string, payload: unknown, id?: string|null }} envelope
 */
function buildReplayPublish(envelope) {
  if (!envelope) throw err('envelope_required');
  assertSafeSrc(envelope.src);
  const data =
    typeof envelope.payload === 'string'
      ? envelope.payload
      : JSON.stringify(envelope.payload);
  return {
    subject: envelope.src,
    data,
    headers: {
      'X-Aura-Dlq-Replay': '1',
      ...(envelope.id ? { 'X-Aura-Dlq-Id': String(envelope.id) } : {}),
    },
  };
}

function envelopeFromRecord(record) {
  const data = record && record.data;
  return parseDlqEnvelope(data);
}

/**
 * @param {Array<{ seq: number, subject?: string, data: unknown }>} records
 * @param {{ seqs?: number[], ids?: string[], src_prefix?: string }} [filter]
 */
function selectRecords(records, filter = {}) {
  const list = Array.isArray(records) ? records : [];
  const seqSet =
    filter.seqs && filter.seqs.length
      ? new Set(filter.seqs.map((n) => Number(n)))
      : null;
  const idSet =
    filter.ids && filter.ids.length ? new Set(filter.ids.map(String)) : null;
  const prefix = filter.src_prefix || null;

  return list.filter((rec) => {
    if (seqSet && !seqSet.has(Number(rec.seq))) return false;
    let env = null;
    try {
      env = envelopeFromRecord(rec);
    } catch {
      // Drop for id/prefix filters; keep otherwise so planReplay can refuse.
      if (idSet || prefix) return false;
      return true;
    }
    if (idSet && !idSet.has(String(env.id))) return false;
    if (prefix && !(env.src && env.src.startsWith(prefix))) return false;
    return true;
  });
}

/**
 * Plan ops replay. Never auto-loops into aura.dlq.*.
 *
 * @param {{
 *   records: Array<{ seq: number, subject?: string, data: unknown }>,
 *   mode: 'dry_run'|'confirm',
 *   max_batch?: number,
 *   seqs?: number[],
 *   ids?: string[],
 *   src_prefix?: string,
 * }} input
 */
function planReplay(input) {
  if (!input || (input.mode !== 'dry_run' && input.mode !== 'confirm')) {
    throw err('mode_invalid', 'mode must be dry_run or confirm');
  }
  const maxBatch =
    input.max_batch != null ? Number(input.max_batch) : DEFAULT_MAX_BATCH;
  if (!Number.isFinite(maxBatch) || maxBatch < 1) {
    throw err('max_batch_invalid');
  }

  const selected = selectRecords(input.records || [], {
    seqs: input.seqs,
    ids: input.ids,
    src_prefix: input.src_prefix,
  });

  const publishes = [];
  const refused = [];
  const skipped = [];

  for (const rec of selected) {
    if (publishes.length >= maxBatch) {
      skipped.push({ seq: rec.seq, reason: 'max_batch' });
      continue;
    }
    try {
      const env = envelopeFromRecord(rec);
      const pub = buildReplayPublish(env);
      publishes.push({
        seq: rec.seq,
        id: env.id,
        subject: pub.subject,
        data: pub.data,
        headers: pub.headers,
        path: env.path,
        tries: env.tries,
      });
    } catch (e) {
      refused.push({
        seq: rec.seq,
        reason: e.code || 'envelope_invalid',
        message: e.message,
      });
    }
  }

  return {
    mode: input.mode,
    execute: input.mode === 'confirm',
    auto_loop: false,
    stream: DLQ_STREAM,
    max_batch: maxBatch,
    selected_count: selected.length,
    publishes,
    refused,
    skipped,
  };
}

module.exports = {
  DLQ_STREAM,
  DLQ_SUBJECT_PREFIX,
  DEFAULT_MAX_BATCH,
  PATH_TERM,
  parseDlqEnvelope,
  buildReplayPublish,
  selectRecords,
  planReplay,
};
