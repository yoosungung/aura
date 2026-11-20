'use strict';

/**
 * Live HTTP entry for aura-llm-gateway.
 * Wires createLlmGateway. AURA_LLM_PROVIDERS_FILE absent → stub chat.
 * Catalog kinds: stub, ollama, openai, vllm, sglang.
 * Optional ConfigMap embeddings → POST /v1/embeddings.
 */

const http = require('http');
const { createLlmGateway } = require('./gateway');
const { loadProvidersFile, loadEmbeddingsConfig } = require('./providers');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tenantFrom(req) {
  const h = req.headers || {};
  return (
    h['x-aura-tenant-id'] ||
    h['x-tenant-id'] ||
    null
  );
}

function gatewayDeps(opts) {
  if (opts.providers || opts.provider) {
    return {
      provider: opts.provider,
      providers: opts.providers,
      fallbackModels: opts.fallbackModels,
      limits: opts.limits,
    };
  }
  const file = opts.providersFile || process.env.AURA_LLM_PROVIDERS_FILE;
  return {
    providers: loadProvidersFile(file, { fetch: globalThis.fetch }),
    fallbackModels: opts.fallbackModels,
    limits: opts.limits,
  };
}

function resolveEmbeddings(opts) {
  if (Object.prototype.hasOwnProperty.call(opts, 'embeddings')) {
    return opts.embeddings;
  }
  const file = opts.providersFile || process.env.AURA_LLM_PROVIDERS_FILE;
  return loadEmbeddingsConfig(file, { fetch: globalThis.fetch });
}

/**
 * @param {{ embed: Function, name?: string, model?: string }} emb
 * @param {object} body
 */
async function handleEmbeddings(emb, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.input == null || b.input === '') {
    return { status: 400, body: { error: 'input_required' } };
  }
  try {
    const out = await emb.embed({
      input: b.input,
      model: typeof b.model === 'string' && b.model ? b.model : undefined,
    });
    return {
      status: 200,
      body: {
        ...out,
        aura: {
          provider: emb.name || out.provider,
          model: out.model || emb.model,
        },
      },
    };
  } catch (e) {
    const code = (e && e.code) || 'provider_error';
    if (code === 'input_required') {
      return { status: 400, body: { error: code } };
    }
    return {
      status: 502,
      body: { error: 'provider_error', message: String(e && e.message) },
    };
  }
}

function createServer(opts = {}) {
  const gw = opts.gateway || createLlmGateway(gatewayDeps(opts));
  const embeddings = resolveEmbeddings(opts);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
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
        const out = await gw.handleChatCompletions({
          tenant_id: tenantFrom(req),
          body,
        });
        res.writeHead(out.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body || {}));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        if (!embeddings) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'embeddings_not_configured' }));
          return;
        }
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
        // tenant header accepted for audit symmetry; no RL this slice
        void tenantFrom(req);
        const out = await handleEmbeddings(embeddings, body);
        res.writeHead(out.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body || {}));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/billing/usage') {
        const filter = {
          tenant_id: url.searchParams.get('tenant_id') || tenantFrom(req) || undefined,
        };
        const fromMs = url.searchParams.get('from_ms');
        const toMs = url.searchParams.get('to_ms');
        if (fromMs) filter.from_ms = Number(fromMs);
        if (toMs) filter.to_ms = Number(toMs);
        const out = gw.handleBillingUsage(filter);
        res.writeHead(out.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body || {}));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'internal',
          message: String(err && err.message),
        })
      );
    }
  });
}

function main() {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('aura-llm-gateway listening on', port);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, main, handleEmbeddings };
