'use strict';

/**
 * resolve cfg + source → Streamable HTTP, signed bundle factory, or explicit miss.
 */

const {
  callToolViaStreamableHttp,
  listToolsViaStreamableHttp,
} = require('./streamable-http');
const { isModuleEntrypoint, openBundleFactory } = require('./bundle-factory');

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

function httpFactory(cfg, d) {
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
        out.result && typeof out.result === 'object' ? out.result : { value: out.result };
      return { ok: true, mode: 'streamable_http', ...payload };
    },
  };
}

function injectedFactory(d) {
  return {
    listTools: d.listTools,
    runTool: d.runTool,
  };
}

/**
 * @param {object} cfg
 * @param {object} deps — source, loadBundle, secrets_ref, fetchImpl, listTools, runTool
 */
async function buildFactory(cfg, deps) {
  const d = deps || {};
  if (cfgUsesStreamableHttp(cfg)) return httpFactory(cfg, d);
  const source = d.source && typeof d.source === 'object' ? d.source : {};
  if (isModuleEntrypoint(source.entrypoint)) {
    if (!source.sig_uri || typeof source.sig_uri !== 'string') {
      const err = new Error('bundle_untrusted');
      err.status = 403;
      throw err;
    }
    return openBundleFactory(source, cfg, d);
  }
  if (typeof d.listTools === 'function' || typeof d.runTool === 'function') {
    return injectedFactory(d);
  }
  const err = new Error('mcp_backend_missing');
  err.status = 500;
  throw err;
}

module.exports = {
  cfgUsesStreamableHttp,
  streamableEndpointFromCfg,
  buildFactory,
};
