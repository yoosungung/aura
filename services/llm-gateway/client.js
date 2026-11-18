'use strict';

/**
 * Function-side LLM client — sole egress to cluster LLM Gateway (ARCHITECTURE §9.4).
 * Constructor / assertFunctionLlmEgress reject provider hosts (openai/anthropic/…).
 */

const GATEWAY_HOSTS = Object.freeze([
  'aura-llm-gateway',
  'aura-llm-gateway.aura',
  'aura-llm-gateway.aura.svc',
  'aura-llm-gateway.aura.svc.cluster.local',
  'localhost',
  '127.0.0.1',
]);

const PROVIDER_BLOCKLIST = Object.freeze([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'api.groq.com',
  'openrouter.ai',
]);

/**
 * @param {string} urlOrHost
 * @returns {string} hostname lowercased
 */
function extractHost(urlOrHost) {
  if (!urlOrHost || typeof urlOrHost !== 'string') {
    const err = new Error('url_required');
    err.code = 'url_required';
    throw err;
  }
  let host = urlOrHost.trim();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      const err = new Error('url_invalid');
      err.code = 'url_invalid';
      throw err;
    }
  } else if (host.includes('/')) {
    host = host.split('/')[0];
  }
  if (host.includes(':') && !host.startsWith('[')) {
    host = host.split(':')[0];
  }
  return host.toLowerCase();
}

/**
 * @param {string} url
 */
function assertFunctionLlmEgress(url) {
  const host = extractHost(url);
  if (PROVIDER_BLOCKLIST.some((b) => host === b || host.endsWith(`.${b}`))) {
    const err = new Error(`provider_direct_forbidden:${host}`);
    err.code = 'provider_direct_forbidden';
    err.host = host;
    throw err;
  }
  const allowed = GATEWAY_HOSTS.some(
    (g) => host === g || host === g.toLowerCase(),
  );
  if (!allowed) {
    const err = new Error(`provider_direct_forbidden:${host}`);
    err.code = 'provider_direct_forbidden';
    err.host = host;
    throw err;
  }
}

/**
 * @param {{ baseUrl: string, transport?: Function }} opts
 */
function createLlmGatewayClient(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!o.baseUrl || typeof o.baseUrl !== 'string') {
    const err = new Error('base_url_required');
    err.code = 'base_url_required';
    throw err;
  }
  assertFunctionLlmEgress(o.baseUrl);
  const base = o.baseUrl.replace(/\/$/, '');
  const transport = o.transport;

  return {
    /**
     * @param {{ tenant_id: string, model: string, messages: object[], stream?: boolean }} req
     */
    async chatCompletions(req) {
      const r = req && typeof req === 'object' ? req : {};
      if (!r.tenant_id || typeof r.tenant_id !== 'string') {
        const err = new Error('tenant_id_required');
        err.code = 'tenant_id_required';
        throw err;
      }
      const body = {
        model: r.model,
        messages: r.messages,
      };
      if (r.stream != null) body.stream = r.stream;
      const path = '/v1/chat/completions';
      if (typeof transport === 'function') {
        return transport({
          method: 'POST',
          url: `${base}${path}`,
          path,
          headers: {
            'content-type': 'application/json',
            'x-aura-tenant-id': r.tenant_id,
          },
          body,
        });
      }
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aura-tenant-id': r.tenant_id,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, body: json };
    },
  };
}

module.exports = {
  GATEWAY_HOSTS,
  PROVIDER_BLOCKLIST,
  extractHost,
  assertFunctionLlmEgress,
  createLlmGatewayClient,
};
