/**
 * Tenant MCP bundle scaffold (nodejs).
 * Upload folder as zip (without node_modules). Entrypoint: main:factory
 */
'use strict';

const { tag } = require('./lib/meta');

/**
 * @param {object} cfg
 * @param {string|null} secrets_ref
 */
function factory(cfg, secrets_ref) {
  const flag = cfg && cfg.flag;
  return {
    async listTools() {
      return {
        ok: true,
        tools: [{ name: 'echo', description: 'echo input' }],
      };
    },
    async runTool(ctx) {
      return {
        ok: true,
        tag,
        tool: ctx && ctx.tool,
        flag: flag || null,
        secrets_ref: secrets_ref || null,
        input: ctx && ctx.input,
      };
    },
  };
}

module.exports = { factory };
