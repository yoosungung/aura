'use strict';

/**
 * Thin HTTP server for aura-control-admin (M6).
 * Handlers: ./admin-http.js — injectable client/objectStore via createAdminHandlers.
 */

const http = require('http');
const { createAdminHandlers } = require('./admin-http');

/**
 * @param {object} opts same as createAdminHandlers + { port?: number }
 */
function createAdminServer(opts = {}) {
  const { dispatch } = createAdminHandlers(opts);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
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
      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) {
        headers[String(k).toLowerCase()] = v;
      }
      const result = await dispatch({
        method: req.method,
        path: url.pathname + url.search,
        authorization: headers.authorization || null,
        headers,
        body,
        query: Object.fromEntries(url.searchParams.entries()),
      });
      res.writeHead(result.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body || {}));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: String(err && err.message) }));
    }
  });
  return server;
}

function main() {
  const port = Number(process.env.PORT || 8080);
  const server = createAdminServer({});
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('aura-control-admin on', port);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createAdminServer, main };
