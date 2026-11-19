'use strict';

/**
 * resolve cfg → listTools / runTool (stub or Streamable HTTP).
 */

const {
  callToolViaStreamableHttp,
  listToolsViaStreamableHttp,
} = require('./streamable-http');

function cfgUsesStreamableHttp(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (cfg.transport === 'streamable_http') return true;
  if (cfg.mcp_endpoint && typeof cfg.mcp_endpoint === 'string') return true;
  return false;
}

function streamableEndpointFromCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  const ep = cfg.mcp_endpoint || cfg.endpoint;
  return typeof ep === 'string' ? ep : '';
}

function sessionOptsFromCfg(cfg) {
  return {
    sessionId:
      typeof cfg.mcp_session_id === 'string'
        ? cfg.mcp_session_id
        : typeof cfg.session_id === 'string'
          ? cfg.session_id
          : undefined,
    protocolVersion:
      typeof cfg.mcp_protocol_version === 'string'
        ? cfg.mcp_protocol_version
        : undefined,
  };
}

async function defaultRunTool(ctx) {
  return {
    ok: true,
    echo: ctx.arguments && typeof ctx.arguments === 'object' ? ctx.arguments : {},
    mode: 'stub',
  };
}

async function defaultListTools() {
  return {
    ok: true,
    tools: [
      {
        name: 'echo',
        description: 'Echo arguments',
        inputSchema: { type: 'object' },
      },
    ],
    mode: 'stub',
  };
}

/**
 * @param {object} cfg
 * @param {object} deps
 */
function buildFactory(cfg, deps) {
  const d = deps || {};
  if (cfgUsesStreamableHttp(cfg)) {
    const endpoint = streamableEndpointFromCfg(cfg);
    if (!endpoint) {
      const err = new Error('mcp_endpoint_required');
      err.status = 500;
      throw err;
    }
    const sess = sessionOptsFromCfg(cfg);
    return {
      async listTools() {
        const out = await listToolsViaStreamableHttp({
          endpoint,
          sessionId: sess.sessionId,
          protocolVersion: sess.protocolVersion,
          fetchImpl: d.fetchImpl,
        });
        if (!out.ok) return out;
        return { ok: true, tools: out.tools || [], mode: 'streamable_http' };
      },
      async runTool(ctx) {
        const out = await callToolViaStreamableHttp({
          endpoint,
          tool: ctx.tool,
          arguments: ctx.arguments,
          sessionId: sess.sessionId,
          protocolVersion: sess.protocolVersion,
          fetchImpl: d.fetchImpl,
        });
        if (!out.ok) return out;
        const payload =
          out.result && typeof out.result === 'object'
            ? out.result
            : { value: out.result };
        return { ok: true, mode: 'streamable_http', ...payload };
      },
    };
  }
  return {
    listTools: d.listTools || defaultListTools,
    runTool: d.runTool || defaultRunTool,
  };
}

module.exports = {
  cfgUsesStreamableHttp,
  streamableEndpointFromCfg,
  buildFactory,
  defaultRunTool,
  defaultListTools,
};
