/**
 * Tenant agent bundle scaffold (nodejs).
 * Upload this folder as zip (without node_modules). Entrypoint: main:factory
 */
'use strict';

const { tag } = require('./lib/echo');

/**
 * @param {object} cfg
 * @param {string|null} secrets_ref
 * @returns {{ runTurn: (input: object) => Promise<object> }}
 */
function factory(cfg, secrets_ref) {
  const system = (cfg && cfg.systemPrompt) || 'You are a helpful agent.';
  return {
    async runTurn(input) {
      return {
        ok: true,
        tag,
        echo: input && input.message,
        system,
        secrets_ref: secrets_ref || null,
      };
    },
  };
}

module.exports = { factory };
