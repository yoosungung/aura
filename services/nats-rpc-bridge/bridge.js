'use strict';

/**
 * Shared NATS Core RR → Fission Router bridge (ARCHITECTURE §3.3 · §4.2).
 * Does not run domain handlers — subject→Function map + HTTP proxy + msg.respond only.
 */

const QUEUE_GROUP = 'aura-rpc-bridge';

const SUBJECT_TO_FUNCTION = Object.freeze({
  'aura.rpc.memory.recall': 'aura-memory-recall',
  'aura.rpc.control.resolve': 'aura-control-resolve',
  'aura.rpc.mcp.tool': 'aura-mcp-invoke-rpc',
});

const SUBJECTS = Object.freeze(Object.keys(SUBJECT_TO_FUNCTION));

/** Sync Function timeout is 30s — bridge fetch aborts slightly earlier. */
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.RPC_FETCH_TIMEOUT_MS || 25000);
/** Per-pod concurrent in-flight RPC handles (HOL mitigation). */
const DEFAULT_MAX_INFLIGHT = Number(process.env.RPC_MAX_INFLIGHT || 32);

function functionForSubject(subject) {
  return SUBJECT_TO_FUNCTION[subject] || null;
}

function routerBase(opts) {
  const raw =
    (opts && opts.routerUrl) ||
    process.env.FISSION_ROUTER_URL ||
    'http://router-internal.fission.svc:8889';
  return String(raw).replace(/\/$/, '');
}

/**
 * Simple semaphore for in-flight message handles.
 * @param {number} max
 */
function createInflightGate(max) {
  const limit = Math.max(1, Number(max) || DEFAULT_MAX_INFLIGHT);
  let active = 0;
  const waiters = [];
  return {
    get active() {
      return active;
    },
    get max() {
      return limit;
    },
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => {
        waiters.push(resolve);
      });
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) next();
    },
  };
}

/**
 * @param {string} functionName
 * @param {string|Buffer|object} payload
 * @param {{ routerUrl?: string, fetchImpl?: typeof fetch, fetchTimeoutMs?: number }} [opts]
 */
async function invokeFission(functionName, payload, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  let body;
  if (Buffer.isBuffer(payload)) body = payload.toString('utf8');
  else if (typeof payload === 'string') body = payload;
  else body = JSON.stringify(payload == null ? {} : payload);

  const url = `${routerBase(o)}/fission-function/${functionName}`;
  const timeoutMs =
    o.fetchTimeoutMs != null ? o.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS;
  // Prefer AbortController+clearTimeout over AbortSignal.timeout (unref timer).
  let signal;
  let timer;
  if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    signal = ac.signal;
    timer = setTimeout(() => ac.abort(), timeoutMs);
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Handle one NATS Core request message.
 * @param {{ subject: string, data: Uint8Array|Buffer|string, respond?: (b: Uint8Array) => void }} msg
 * @param {{ sc: { decode: Function, encode: Function }, invoke?: Function, routerUrl?: string, fetchImpl?: Function, fetchTimeoutMs?: number }} opts
 */
async function handleNatsMessage(msg, opts) {
  const o = opts || {};
  const sc = o.sc;
  if (!sc || typeof sc.decode !== 'function' || typeof sc.encode !== 'function') {
    throw new Error('string_codec_required');
  }

  const subject = msg && msg.subject;
  const fn = functionForSubject(subject);
  let replyBody;
  let status = 200;

  if (!fn) {
    status = 404;
    replyBody = JSON.stringify({
      ok: false,
      error: 'unknown_rpc_subject',
      subject: subject || null,
    });
  } else {
    let payload = '{}';
    try {
      payload = sc.decode(msg.data);
    } catch (_) {
      payload = '{}';
    }
    try {
      const invoke = o.invoke || invokeFission;
      const out = await invoke(fn, payload, {
        routerUrl: o.routerUrl,
        fetchImpl: o.fetchImpl,
        fetchTimeoutMs: o.fetchTimeoutMs,
      });
      status = out.status;
      replyBody =
        typeof out.body === 'string' ? out.body : JSON.stringify(out.body || {});
      if (!replyBody) {
        replyBody = JSON.stringify({
          ok: false,
          error: 'empty_function_response',
          function: fn,
          status,
        });
      }
    } catch (err) {
      status = 502;
      replyBody = JSON.stringify({
        ok: false,
        error: 'fission_invoke_failed',
        detail: String(err && err.message ? err.message : err),
        function: fn,
        subject,
      });
    }
  }

  if (typeof msg.respond === 'function') {
    msg.respond(sc.encode(replyBody));
  }
  return { status, body: replyBody, function: fn };
}

/**
 * Fire-and-forget handle with optional inflight gate (avoids HOL blocking in sub loop).
 * @returns {Promise<void>} settles when handle finishes (for tests); loop does not await.
 */
function dispatchNatsMessage(msg, opts, gate) {
  return (async () => {
    if (gate) await gate.acquire();
    try {
      await handleNatsMessage(msg, opts);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('nats-rpc-bridge handle error', err);
    } finally {
      if (gate) gate.release();
    }
  })();
}

/**
 * @param {{
 *   servers?: string,
 *   queue?: string,
 *   subjects?: string[],
 *   connect?: Function,
 *   routerUrl?: string,
 *   fetchImpl?: Function,
 *   invoke?: Function,
 *   fetchTimeoutMs?: number,
 *   maxInflight?: number,
 * }} [opts]
 */
async function startBridge(opts) {
  const o = opts || {};
  const queue = o.queue || process.env.RPC_QUEUE || QUEUE_GROUP;
  const servers = o.servers || process.env.NATS_URL || 'nats://127.0.0.1:4222';
  const subjects = o.subjects || SUBJECTS;
  const maxInflight = o.maxInflight != null ? o.maxInflight : DEFAULT_MAX_INFLIGHT;
  const gate = createInflightGate(maxInflight);

  const connect =
    o.connect ||
    (async (cfg) => {
      // eslint-disable-next-line import/no-extraneous-dependencies, global-require
      const { connect: natsConnect, StringCodec } = require('nats');
      const nc = await natsConnect(cfg);
      return { nc, sc: StringCodec() };
    });

  const { nc, sc } = await connect({ servers });
  const subs = [];

  for (const subject of subjects) {
    const sub = nc.subscribe(subject, { queue });
    subs.push(sub);
    // eslint-disable-next-line no-console
    console.log(
      `nats-rpc-bridge listen subject=${subject} queue=${queue} maxInflight=${gate.max}`,
    );
    (async () => {
      for await (const msg of sub) {
        // Do not await — parallel dispatch; gate caps concurrency.
        void dispatchNatsMessage(
          { subject, data: msg.data, respond: msg.respond.bind(msg) },
          {
            sc,
            routerUrl: o.routerUrl,
            fetchImpl: o.fetchImpl,
            invoke: o.invoke,
            fetchTimeoutMs: o.fetchTimeoutMs,
          },
          gate,
        );
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('nats-rpc-bridge loop error', err);
      process.exit(1);
    });
  }

  return { nc, subs, queue, subjects, gate };
}

if (require.main === module) {
  startBridge().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  QUEUE_GROUP,
  SUBJECT_TO_FUNCTION,
  SUBJECTS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_INFLIGHT,
  functionForSubject,
  createInflightGate,
  invokeFission,
  handleNatsMessage,
  dispatchNatsMessage,
  startBridge,
};
