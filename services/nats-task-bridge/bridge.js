'use strict';

/**
 * Shared JetStream → Fission Router task bridge (ARCHITECTURE §4.1 · M3.6).
 * agent/mcp async only — no domain handlers. runtime stamp → Function map.
 */

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.TASK_FETCH_TIMEOUT_MS || 110000);
/** Cap concurrent Router invokes per process (HOL 방지; long agent turns). */
const DEFAULT_MAX_INFLIGHT = Number(process.env.TASK_MAX_INFLIGHT || 32);
/** JetStream AckWait floor: fetch timeout + 40s margin (default 150s). */
const DEFAULT_ACK_WAIT_MS = Number(
  process.env.TASK_ACK_WAIT_MS || desiredAckWaitMs(DEFAULT_FETCH_TIMEOUT_MS),
);
/** In-progress heartbeat interval (must be ≪ AckWait). */
const DEFAULT_WORKING_INTERVAL_MS = Number(process.env.TASK_WORKING_INTERVAL_MS || 10000);
const DEFAULT_MAX_DELIVER = Number(process.env.TASK_MAX_DELIVER || 5);
const DEFAULT_RUNTIME = 'nodejs';

function desiredAckWaitMs(fetchTimeoutMs) {
  const fetchMs = Number(fetchTimeoutMs) > 0 ? Number(fetchTimeoutMs) : 110000;
  return fetchMs + 40000;
}

function msToNanos(ms) {
  return Math.max(1, Math.floor(Number(ms) || 0) * 1e6);
}

const TASK_ROUTES = Object.freeze({
  'aura.tasks.agent.invoke': Object.freeze({
    nodejs: 'aura-agent-invoke',
    python: 'aura-agent-invoke-py',
    respTopic: 'aura.events.agent.invoke.done',
    errorTopic: 'aura.events.agent.invoke.error',
  }),
  'aura.tasks.mcp.invoke': Object.freeze({
    nodejs: 'aura-mcp-invoke',
    python: 'aura-mcp-invoke-py',
    respTopic: 'aura.events.mcp.invoke.done',
    errorTopic: 'aura.events.mcp.invoke.error',
  }),
});

const TASK_SUBJECTS = Object.freeze(Object.keys(TASK_ROUTES));

const CUSTOM_PREFIX = Object.freeze({
  'aura.tasks.agent.invoke': 'aura-agent-invoke-',
  'aura.tasks.mcp.invoke': 'aura-mcp-invoke-',
});

const CUSTOM_DENY = new Set(['aura-agent-invoke-py', 'aura-mcp-invoke-py']);

function allowedCustomFunction(subject, functionName) {
  const prefix = CUSTOM_PREFIX[subject];
  if (!prefix || typeof functionName !== 'string') return null;
  if (functionName.length > 63 || functionName.length <= prefix.length) return null;
  if (!functionName.startsWith(prefix)) return null;
  if (subject === 'aura.tasks.mcp.invoke' && functionName.startsWith('aura-mcp-invoke-rpc-')) {
    return null;
  }
  if (CUSTOM_DENY.has(functionName)) return null;
  const rest = functionName.slice(prefix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rest)) return null;
  return functionName;
}

function parseRuntime(payload) {
  if (payload == null) return DEFAULT_RUNTIME;
  let obj = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      return DEFAULT_RUNTIME;
    }
  }
  if (obj && typeof obj === 'object' && typeof obj.runtime === 'string' && obj.runtime) {
    return obj.runtime;
  }
  return DEFAULT_RUNTIME;
}

function parseFunctionName(payload) {
  if (payload == null || typeof payload === 'number') return '';
  let obj = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      return '';
    }
  }
  if (obj && typeof obj === 'object' && typeof obj.function === 'string') return obj.function;
  return '';
}

function functionForTask(subject, runtime, functionName) {
  const route = TASK_ROUTES[subject];
  if (!route) return null;
  const rt = runtime || DEFAULT_RUNTIME;
  if (rt === 'custom') return allowedCustomFunction(subject, functionName);
  return route[rt] || route.nodejs || null;
}

function topicsForTask(subject) {
  const route = TASK_ROUTES[subject];
  if (!route) return null;
  return { respTopic: route.respTopic, errorTopic: route.errorTopic };
}

function routerBase(opts) {
  const raw =
    (opts && opts.routerUrl) ||
    process.env.FISSION_ROUTER_URL ||
    'http://router-internal.fission.svc:8889';
  return String(raw).replace(/\/$/, '');
}

/**
 * Simple semaphore for in-flight task handles (same shape as nats-rpc-bridge).
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
 * Process one JetStream message: route → Router → publish done/error.
 */
async function handleTaskMessage(msg, opts) {
  const o = opts || {};
  const sc = o.sc;
  if (!sc || typeof sc.decode !== 'function' || typeof sc.encode !== 'function') {
    throw new Error('string_codec_required');
  }
  const subject = msg && msg.subject;
  const routeTopics = topicsForTask(subject);
  let payload = '{}';
  try {
    payload = sc.decode(msg.data);
  } catch (_) {
    payload = '{}';
  }
  const runtime = parseRuntime(payload);
  const fn = functionForTask(subject, runtime, parseFunctionName(payload));

  const publish =
    typeof o.publish === 'function'
      ? o.publish
      : async () => {
          throw new Error('publish_required');
        };

  if (!fn || !routeTopics) {
    const error = routeTopics ? 'function_not_allowed' : 'unknown_task_subject';
    await publish(routeTopics ? routeTopics.errorTopic : 'aura.events.agent.invoke.error', {
      ok: false,
      error,
      subject: subject || null,
    });
    if (typeof msg.ack === 'function') await msg.ack();
    return { ok: false, error };
  }

  try {
    const invoke = o.invoke || invokeFission;
    const out = await invoke(fn, payload, {
      routerUrl: o.routerUrl,
      fetchImpl: o.fetchImpl,
      fetchTimeoutMs: o.fetchTimeoutMs,
    });
    let bodyObj;
    try {
      bodyObj = JSON.parse(out.body || '{}');
    } catch (_) {
      bodyObj = { ok: false, error: 'invalid_function_json', raw: out.body };
    }
    if (out.status >= 200 && out.status < 300) {
      await publish(routeTopics.respTopic, bodyObj);
    } else {
      await publish(routeTopics.errorTopic, {
        ok: false,
        error: bodyObj.error || 'function_error',
        status: out.status,
        function: fn,
        body: bodyObj,
      });
    }
    if (typeof msg.ack === 'function') await msg.ack();
    return { ok: true, function: fn, status: out.status };
  } catch (err) {
    await publish(routeTopics.errorTopic, {
      ok: false,
      error: 'fission_invoke_failed',
      detail: String(err && err.message ? err.message : err),
      function: fn,
      subject,
    });
    if (typeof msg.nak === 'function') await msg.nak();
    else if (typeof msg.ack === 'function') await msg.ack();
    return { ok: false, error: 'fission_invoke_failed' };
  }
}

/**
 * Periodic JetStream in-progress (`msg.working`) so AckWait does not redeliver mid-invoke.
 * @param {{ working?: () => void }} msg
 * @param {number} [intervalMs]
 * @returns {() => void} dispose
 */
function startWorkingHeartbeat(msg, intervalMs) {
  const ms =
    intervalMs != null ? Number(intervalMs) : DEFAULT_WORKING_INTERVAL_MS;
  if (!(ms > 0) || !msg || typeof msg.working !== 'function') {
    return () => {};
  }
  const tick = () => {
    try {
      msg.working();
    } catch (_) {
      /* ignore */
    }
  };
  tick();
  const timer = setInterval(tick, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * Consumer config for task-bridge durables (AckWait ≥ fetch+margin).
 * ack_wait is nanoseconds (NATS JetStream API).
 */
function ensureTaskConsumerConfig(subject, durable, opts) {
  const o = opts || {};
  const ackWaitMs =
    o.ackWaitMs != null ? Number(o.ackWaitMs) : DEFAULT_ACK_WAIT_MS;
  const maxDeliver =
    o.maxDeliver != null ? Number(o.maxDeliver) : DEFAULT_MAX_DELIVER;
  return {
    durable_name: durable,
    filter_subject: subject,
    ack_policy: 'explicit',
    ack_wait: msToNanos(ackWaitMs),
    max_deliver: maxDeliver,
  };
}

/**
 * Add or update pull consumer so AckWait covers long Router invokes.
 * @param {{ consumers: { info: Function, add: Function, update: Function } }} jsm
 */
async function ensureTaskConsumer(jsm, stream, subject, durable, opts) {
  const cfg = ensureTaskConsumerConfig(subject, durable, opts);
  if (!jsm || !jsm.consumers) {
    throw new Error('jetstream_manager_required');
  }
  let info;
  try {
    info = await jsm.consumers.info(stream, durable);
  } catch (_) {
    info = null;
  }
  if (!info) {
    await jsm.consumers.add(stream, cfg);
    return { action: 'add', config: cfg };
  }
  const currentWait = Number(info.config && info.config.ack_wait) || 0;
  const currentDeliver = Number(info.config && info.config.max_deliver) || 0;
  const needWait = currentWait < cfg.ack_wait;
  const needDeliver =
    currentDeliver !== cfg.max_deliver && cfg.max_deliver > 0;
  if (needWait || needDeliver) {
    await jsm.consumers.update(stream, durable, {
      ack_wait: cfg.ack_wait,
      max_deliver: cfg.max_deliver,
    });
    return { action: 'update', config: cfg };
  }
  return { action: 'noop', config: cfg };
}

/**
 * Fire-and-forget handle with inflight gate (avoids HOL blocking in consume loop).
 * @returns {Promise<void>} settles when handle finishes (for tests); loop does not await.
 */
function dispatchTaskMessage(msg, opts, gate) {
  return (async () => {
    if (gate) await gate.acquire();
    const stopWorking = startWorkingHeartbeat(
      msg,
      opts && opts.workingIntervalMs,
    );
    try {
      await handleTaskMessage(msg, opts);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('nats-task-bridge handle error', err);
      try {
        if (typeof msg.nak === 'function') await msg.nak();
      } catch (_) {
        /* ignore */
      }
    } finally {
      stopWorking();
      if (gate) gate.release();
    }
  })();
}

/**
 * JetStream pull consumers for agent/mcp tasks → Router.
 */
async function startTaskBridge(opts) {
  const o = opts || {};
  const servers = o.servers || process.env.NATS_URL || 'nats://127.0.0.1:4222';
  const subjects = o.subjects || TASK_SUBJECTS;
  const stream = o.stream || process.env.TASK_STREAM || 'AURA_TASKS';
  const maxInflight = o.maxInflight != null ? o.maxInflight : DEFAULT_MAX_INFLIGHT;
  const gate = createInflightGate(maxInflight);
  const ackWaitMs = o.ackWaitMs != null ? o.ackWaitMs : DEFAULT_ACK_WAIT_MS;
  const maxDeliver = o.maxDeliver != null ? o.maxDeliver : DEFAULT_MAX_DELIVER;
  const workingIntervalMs =
    o.workingIntervalMs != null ? o.workingIntervalMs : DEFAULT_WORKING_INTERVAL_MS;

  const connect =
    o.connect ||
    (async (cfg) => {
      // eslint-disable-next-line import/no-extraneous-dependencies, global-require
      const { connect: natsConnect, StringCodec } = require('nats');
      const nc = await natsConnect(cfg);
      return { nc, sc: StringCodec() };
    });

  const { nc, sc } = await connect({ servers });
  const js = nc.jetstream();
  const jsm =
    o.jsm ||
    (typeof nc.jetstreamManager === 'function' ? await nc.jetstreamManager() : null);
  const consumers = [];
  const ensured = [];

  const publish = async (subject, body) => {
    const data = sc.encode(typeof body === 'string' ? body : JSON.stringify(body));
    await js.publish(subject, data);
  };

  for (const subject of subjects) {
    const durable =
      subject === 'aura.tasks.agent.invoke'
        ? 'aura_task_bridge_agent'
        : 'aura_task_bridge_mcp';
    if (jsm) {
      try {
        const res = await ensureTaskConsumer(jsm, stream, subject, durable, {
          ackWaitMs,
          maxDeliver,
        });
        ensured.push({ durable, ...res });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `task-bridge: ensure consumer ${durable} failed:`,
          err && err.message ? err.message : err,
        );
      }
    }
    const consumer = await js.consumers.get(stream, durable).catch(async () => {
      // eslint-disable-next-line no-console
      console.warn(
        `task-bridge: consumer ${durable} missing — run ensure-task-bridge-consumers.sh`,
      );
      return null;
    });
    if (!consumer) continue;
    consumers.push(consumer);
    // eslint-disable-next-line no-console
    console.log(
      `nats-task-bridge listen subject=${subject} durable=${durable} maxInflight=${gate.max} ackWaitMs=${ackWaitMs} workingIntervalMs=${workingIntervalMs}`,
    );
    (async () => {
      const messages = await consumer.consume();
      for await (const m of messages) {
        // Do not await — parallel dispatch; gate caps concurrency.
        void dispatchTaskMessage(
          {
            subject: m.subject || subject,
            data: m.data,
            ack: () => m.ack(),
            nak: () => m.nak(),
            working: typeof m.working === 'function' ? () => m.working() : undefined,
          },
          {
            sc,
            publish,
            routerUrl: o.routerUrl,
            fetchImpl: o.fetchImpl,
            invoke: o.invoke,
            fetchTimeoutMs: o.fetchTimeoutMs,
            workingIntervalMs,
          },
          gate,
        );
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('nats-task-bridge loop error', err);
      process.exit(1);
    });
  }

  return { nc, consumers, subjects, stream, gate, ensured, ackWaitMs };
}

if (require.main === module) {
  startTaskBridge().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_RUNTIME,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_INFLIGHT,
  DEFAULT_ACK_WAIT_MS,
  DEFAULT_WORKING_INTERVAL_MS,
  DEFAULT_MAX_DELIVER,
  TASK_ROUTES,
  TASK_SUBJECTS,
  parseRuntime,
  functionForTask,
  topicsForTask,
  desiredAckWaitMs,
  msToNanos,
  createInflightGate,
  startWorkingHeartbeat,
  ensureTaskConsumerConfig,
  ensureTaskConsumer,
  invokeFission,
  handleTaskMessage,
  dispatchTaskMessage,
  startTaskBridge,
};
