'use strict';

/**
 * Shared JetStream → Fission Router task bridge (ARCHITECTURE §4.1 · M3.6).
 * agent/mcp async only — no domain handlers. runtime stamp → Function map.
 */

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.TASK_FETCH_TIMEOUT_MS || 110000);
const DEFAULT_RUNTIME = 'nodejs';

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

function functionForTask(subject, runtime) {
  const route = TASK_ROUTES[subject];
  if (!route) return null;
  const rt = runtime || DEFAULT_RUNTIME;
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
  const fn = functionForTask(subject, runtime);

  const publish =
    typeof o.publish === 'function'
      ? o.publish
      : async () => {
          throw new Error('publish_required');
        };

  if (!fn || !routeTopics) {
    await publish(routeTopics ? routeTopics.errorTopic : 'aura.events.agent.invoke.error', {
      ok: false,
      error: 'unknown_task_subject',
      subject: subject || null,
    });
    if (typeof msg.ack === 'function') await msg.ack();
    return { ok: false, error: 'unknown_task_subject' };
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
 * JetStream pull consumers for agent/mcp tasks → Router.
 */
async function startTaskBridge(opts) {
  const o = opts || {};
  const servers = o.servers || process.env.NATS_URL || 'nats://127.0.0.1:4222';
  const subjects = o.subjects || TASK_SUBJECTS;
  const stream = o.stream || process.env.TASK_STREAM || 'AURA_TASKS';

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
  const consumers = [];

  const publish = async (subject, body) => {
    const data = sc.encode(typeof body === 'string' ? body : JSON.stringify(body));
    await js.publish(subject, data);
  };

  for (const subject of subjects) {
    const durable =
      subject === 'aura.tasks.agent.invoke'
        ? 'aura_task_bridge_agent'
        : 'aura_task_bridge_mcp';
    const consumer = await js.consumers.get(stream, durable).catch(async () => {
      // eslint-disable-next-line no-console
      console.warn(`task-bridge: consumer ${durable} missing — create via ensure-streams`);
      return null;
    });
    if (!consumer) continue;
    consumers.push(consumer);
    // eslint-disable-next-line no-console
    console.log(`nats-task-bridge listen subject=${subject} durable=${durable}`);
    (async () => {
      const messages = await consumer.consume();
      for await (const m of messages) {
        try {
          await handleTaskMessage(
            {
              subject: m.subject || subject,
              data: m.data,
              ack: () => m.ack(),
              nak: () => m.nak(),
            },
            {
              sc,
              publish,
              routerUrl: o.routerUrl,
              fetchImpl: o.fetchImpl,
              invoke: o.invoke,
              fetchTimeoutMs: o.fetchTimeoutMs,
            },
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('nats-task-bridge handle error', err);
          try {
            m.nak();
          } catch (_) {
            /* ignore */
          }
        }
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('nats-task-bridge loop error', err);
      process.exit(1);
    });
  }

  return { nc, consumers, subjects, stream };
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
  TASK_ROUTES,
  TASK_SUBJECTS,
  parseRuntime,
  functionForTask,
  topicsForTask,
  invokeFission,
  handleTaskMessage,
  startTaskBridge,
};
