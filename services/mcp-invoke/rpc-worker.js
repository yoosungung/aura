'use strict';

/**
 * NATS Core Request-Reply worker for aura.rpc.mcp.tool (M3.5).
 * Replaces nats-box echo stub. queue-group: aura-mcp-invoke.
 */

const handler = require('./handler');

async function startRpcWorker(opts) {
  const o = opts || {};
  const subject = o.subject || process.env.RPC_SUBJECT || 'aura.rpc.mcp.tool';
  const queue = o.queue || process.env.RPC_QUEUE || 'aura-mcp-invoke';
  const servers = o.servers || process.env.NATS_URL || 'nats://127.0.0.1:4222';

  const connect =
    o.connect ||
    (async (cfg) => {
      // eslint-disable-next-line import/no-extraneous-dependencies, global-require
      const { connect: natsConnect, StringCodec } = require('nats');
      const nc = await natsConnect(cfg);
      return { nc, sc: StringCodec() };
    });

  const { nc, sc } = await connect({ servers });
  const sub = nc.subscribe(subject, { queue });
  // eslint-disable-next-line no-console
  console.log(`mcp rpc-worker listening subject=${subject} queue=${queue}`);

  (async () => {
    for await (const msg of sub) {
      let body = {};
      try {
        body = JSON.parse(sc.decode(msg.data));
      } catch (_) {
        body = {};
      }
      const res = await handler({
        mode: 'rpc',
        rpcSubject: subject,
        request: { body: JSON.stringify(body), headers: { 'x-aura-rpc': subject } },
        resolve: o.resolve,
        runTool: o.runTool,
        listTools: o.listTools,
        fetchImpl: o.fetchImpl,
      });
      const reply =
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body || {});
      if (msg.respond) {
        msg.respond(sc.encode(reply));
      }
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('rpc-worker loop error', err);
    process.exit(1);
  });

  return { nc, sub };
}

if (require.main === module) {
  startRpcWorker().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { startRpcWorker };
