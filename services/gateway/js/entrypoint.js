'use strict';

/**
 * Live HTTP entry for aura-gateway.
 * Wires gateway.js handlers; memory KV quota (live JetStream KV = Non-goal).
 * NATS publish/subscribe when NATS_URL is reachable.
 */

const http = require('http');
const {
  createRunRegistry,
  createMemoryKv,
  createTenantRateLimiter,
  handleSubmitHttp,
  openStreamBridge,
  formatSseFrame,
  authorizeWs,
} = require('./gateway');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function principalFrom(req) {
  const h = req.headers || {};
  const id = h['x-aura-principal-id'] || h['x-principal-id'];
  const tenant_id = h['x-aura-tenant-id'] || h['x-tenant-id'];
  if (!id || !tenant_id) return null;
  return { id: String(id), tenant_id: String(tenant_id) };
}

async function connectNats(url) {
  if (!url) return null;
  // Lazy require so unit imports without nats still work.
  const { connect, StringCodec } = require('nats');
  const nc = await connect({ servers: url });
  const sc = StringCodec();
  return {
    async publishTask(subject, task) {
      nc.publish(subject, sc.encode(JSON.stringify(task)));
    },
    async subscribeStream(subject, onFrame) {
      const sub = nc.subscribe(subject);
      const pump = (async () => {
        for await (const m of sub) {
          let raw = sc.decode(m.data);
          try {
            raw = JSON.parse(raw);
          } catch {
            /* leave string for openStreamBridge */
          }
          await onFrame(raw);
        }
      })();
      pump.catch(() => {});
      return {
        close: async () => {
          try {
            sub.unsubscribe();
          } catch {
            /* ignore */
          }
        },
      };
    },
    async close() {
      await nc.drain().catch(() => nc.close());
    },
  };
}

function createServer(opts = {}) {
  const registry = opts.registry || createRunRegistry();
  const kv = opts.kv || createMemoryKv();
  const rateLimiter =
    opts.rateLimiter || createTenantRateLimiter({ kv });
  let nats = opts.nats || null;

  const depsBase = () => ({
    registry,
    rateLimiter,
    publishTask: nats
      ? nats.publishTask.bind(nats)
      : async () => {
          const err = new Error('nats_unavailable');
          err.status = 503;
          throw err;
        },
    subscribeStream: nats
      ? nats.subscribeStream.bind(nats)
      : async () => {
          const err = new Error('nats_unavailable');
          err.status = 503;
          throw err;
        },
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/agent/invoke') {
        const principal = principalFrom(req);
        const raw = await readBody(req);
        let body = {};
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }
        }
        const out = await handleSubmitHttp(
          { principal, body },
          depsBase()
        );
        res.writeHead(out.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body || {}));
        return;
      }

      const sseMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (req.method === 'GET' && sseMatch) {
        const runId = decodeURIComponent(sseMatch[1]);
        const principal = principalFrom(req);
        const pre = registry.authorize(runId, principal);
        if (!pre.ok) {
          res.writeHead(pre.status || 403, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({ error: pre.error || 'forbidden' }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let bridge;
        try {
          bridge = await openStreamBridge(
            runId,
            principal,
            depsBase(),
            async (frame) => {
              res.write(formatSseFrame(frame));
            }
          );
        } catch (err) {
          res.write(
            formatSseFrame({
              type: 'error',
              message: err.message || 'sse_failed',
            })
          );
          res.end();
          return;
        }
        req.on('close', () => {
          if (bridge && typeof bridge.close === 'function') {
            bridge.close().catch(() => {});
          }
        });
        return;
      }

      const wsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/ws$/);
      if (req.method === 'GET' && wsMatch) {
        const runId = decodeURIComponent(wsMatch[1]);
        const principal = principalFrom(req);
        const auth = authorizeWs(runId, principal, registry);
        if (!auth.ok) {
          res.writeHead(auth.status || 403, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({ error: auth.error || 'forbidden' }));
          return;
        }
        // Native WS upgrade is a follow-up; SSE is the primary stream path.
        res.writeHead(501, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'websocket_upgrade_pending',
            hint: 'use GET /v1/runs/:run_id/events (SSE)',
            subject: auth.subject,
          })
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          error: 'internal',
          message: String(err && err.message),
        })
      );
    }
  });

  server.setNats = (client) => {
    nats = client;
  };
  return server;
}

async function main() {
  const port = Number(process.env.PORT || 8080);
  const natsUrl = process.env.NATS_URL || '';
  const server = createServer();
  if (natsUrl) {
    try {
      const client = await connectNats(natsUrl);
      server.setNats(client);
      // eslint-disable-next-line no-console
      console.log('aura-gateway nats connected', natsUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        'aura-gateway nats connect failed; invoke/SSE return 503 until restart',
        String(err && err.message)
      );
    }
  }
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('aura-gateway listening on', port);
  });
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer, connectNats, main };
