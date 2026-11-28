'use strict';

/**
 * Live NATS Core helpers for agent_invoke (Phase B).
 * Injectable `connect` for tests; production uses `nats` package.
 */

function buildStreamSubject(runId) {
  return `aura.stream.${runId}`;
}

/**
 * @param {{
 *   servers?: string,
 *   connect?: Function,
 *   requestTimeoutMs?: number,
 * }} opts
 */
async function createNatsDeps(opts) {
  const o = opts || {};
  let nc = o.nc;
  if (!nc) {
    const connect =
      o.connect ||
      (async (...args) => {
        // eslint-disable-next-line import/no-extraneous-dependencies, global-require
        const { connect: natsConnect } = require('nats');
        return natsConnect(...args);
      });
    nc = await connect({
      servers: o.servers || process.env.NATS_URL || 'nats://127.0.0.1:4222',
    });
  }
  const sc =
    o.stringCodec ||
    (await (async () => {
      try {
        // eslint-disable-next-line global-require
        return require('nats').StringCodec();
      } catch (_) {
        return {
          encode: (s) => Buffer.from(String(s)),
          decode: (b) => Buffer.from(b).toString('utf8'),
        };
      }
    })());
  const timeout = o.requestTimeoutMs || 5000;

  async function requestJson(subject, payload) {
    const msg = await nc.request(
      subject,
      sc.encode(JSON.stringify(payload || {})),
      { timeout },
    );
    return JSON.parse(sc.decode(msg.data));
  }

  return {
    nc,
    async resolve(req) {
      return requestJson('aura.rpc.control.resolve', req);
    },
    async recall(req) {
      return requestJson('aura.rpc.memory.recall', req);
    },
    async mcpTool(req) {
      return requestJson('aura.rpc.mcp.tool', req);
    },
    async publishStream(runId, frame) {
      nc.publish(
        buildStreamSubject(runId),
        sc.encode(JSON.stringify(frame || {})),
      );
    },
    async publishCapture(envelope) {
      const js = nc.jetstream ? nc.jetstream() : null;
      const payload = sc.encode(JSON.stringify(envelope || {}));
      if (js && typeof js.publish === 'function') {
        await js.publish('aura.tasks.memory.capture', payload);
        return;
      }
      nc.publish('aura.tasks.memory.capture', payload);
    },
    async close() {
      if (nc && typeof nc.close === 'function') await nc.close();
    },
  };
}

/**
 * Lazy JetStream publisher for turn-end → aura.tasks.memory.capture.
 * @param {{ servers?: string, connect?: Function }} opts
 */
function createCapturePublisher(opts) {
  const o = opts || {};
  let depsPromise = null;
  async function ensure() {
    if (!depsPromise) depsPromise = createNatsDeps(o);
    return depsPromise;
  }
  return async function publishCapture(envelope) {
    const deps = await ensure();
    return deps.publishCapture(envelope);
  };
}

module.exports = {
  buildStreamSubject,
  createNatsDeps,
  createCapturePublisher,
};
