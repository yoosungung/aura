/**
 * Tenant MCP bundle scaffold (nodejs) — Naver Search example.
 * Upload folder as zip (without node_modules). Entrypoint: main:factory
 */
'use strict';

const { tag } = require('./lib/meta');
const { materializeSecrets, searchNaver, SERVICES } = require('./lib/naver-search');

const TOOL = {
  name: 'naver_search',
  description:
    'Search Naver (web/news/blog/…). Requires secrets { client_id, client_secret } or NAVER_CLIENT_* env. Cluster egress must allow openapi.naver.com.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query (UTF-8)' },
      service: {
        type: 'string',
        description: `API path id; default from cfg.service or webkr. One of: ${[...SERVICES].join(', ')}`,
      },
      display: { type: 'integer', minimum: 1, maximum: 100 },
      start: { type: 'integer', minimum: 1, maximum: 1000 },
      sort: { type: 'string', description: 'sim | date (when supported by service)' },
    },
  },
};

/**
 * @param {object} cfg
 * @param {object|string|null} secrets — materialized map, or secrets_ref string (+ env fallback)
 */
function factory(cfg, secrets) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const defaultService = c.service != null ? String(c.service) : 'webkr';
  const defaultDisplay = c.display != null ? Number(c.display) : undefined;
  const fetchImpl = c.fetchImpl || c._fetch || undefined;

  return {
    async listTools() {
      return { ok: true, tools: [TOOL] };
    },
    async runTool(ctx) {
      const tool = ctx && ctx.tool;
      if (tool !== 'naver_search') {
        return { ok: false, error: 'unknown_tool', tool: tool || null };
      }
      const creds = materializeSecrets(secrets);
      if (!creds) {
        return {
          ok: false,
          error: 'secrets_unresolved',
          secrets_ref: typeof secrets === 'string' ? secrets : null,
        };
      }
      const input = (ctx && ctx.input) || {};
      const out = await searchNaver({
        query: input.query,
        service: input.service != null ? input.service : defaultService,
        display: input.display != null ? input.display : defaultDisplay,
        start: input.start,
        sort: input.sort,
        creds,
        fetchImpl,
      });
      if (!out.ok) return out;
      return { ok: true, tag, tool: 'naver_search', ...out };
    },
  };
}

module.exports = { factory };
