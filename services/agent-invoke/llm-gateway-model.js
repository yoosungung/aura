'use strict';

/**
 * LangChain-facing chat model that only talks to Aura LLM Gateway (§9.4).
 * Always runs assertFunctionLlmEgress before any call.
 */

const path = require('path');
const fs = require('fs');

function loadGatewayClient() {
  const candidates = [
    path.join(__dirname, 'llm-gateway-client.js'), // archive layout
    path.join(__dirname, '..', 'llm-gateway', 'client.js'), // monorepo
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('llm_gateway_client_missing');
}

const {
  assertFunctionLlmEgress,
  createLlmGatewayClient,
} = loadGatewayClient();

/**
 * @param {{ baseUrl: string, tenantId: string, model?: string, transport?: Function }} opts
 */
function createGatewayChatModel(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!o.baseUrl || typeof o.baseUrl !== 'string') {
    const err = new Error('base_url_required');
    err.code = 'base_url_required';
    throw err;
  }
  assertFunctionLlmEgress(o.baseUrl);
  if (!o.tenantId || typeof o.tenantId !== 'string') {
    const err = new Error('tenant_id_required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const client = createLlmGatewayClient({
    baseUrl: o.baseUrl,
    transport: o.transport,
  });
  const modelName = o.model || 'aura-default';

  return {
    _auraGateway: true,
    model: modelName,
    tenantId: o.tenantId,
    /**
     * Minimal invoke used by createAgent adapters / tests.
     * @param {Array<{role:string,content:string}>} messages
     */
    async invoke(messages) {
      const res = await client.chatCompletions({
        tenant_id: o.tenantId,
        model: modelName,
        messages: Array.isArray(messages) ? messages : [],
      });
      const body = res && res.body;
      const choice =
        body &&
        body.choices &&
        body.choices[0] &&
        body.choices[0].message &&
        body.choices[0].message.content;
      return {
        content: typeof choice === 'string' ? choice : '',
        raw: res,
      };
    },
  };
}

module.exports = {
  assertFunctionLlmEgress,
  createLlmGatewayClient,
  createGatewayChatModel,
};
