'use strict';

/**
 * mcp_invoke dual entry — ARCHITECTURE §1 #10·#11·#12 · §3.2 · §3.3 · §7 · §8.
 * M3.5: action=list|call · archive package · factory.js.
 */

const fs = require('fs');
const path = require('path');
const { buildFactory } = require('./factory');

function requireObjectStore(file) {
  const candidates = [
    path.join(__dirname, file),
    path.join(__dirname, '..', '..', 'object-store', file),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  const err = new Error('object_store_module_missing');
  err.status = 500;
  throw err;
}

function defaultLoadBundle(tenantId, deps) {
  const { loadCachedBundle } = requireObjectStore('bundle-cache.js');
  const d = deps || {};
  return (source) =>
    loadCachedBundle(source, {
      tenantId,
      fetchImpl: d.objectFetch,
      endpoint: d.objectEndpoint,
      region: d.objectRegion,
      accessKeyId: d.objectAccessKeyId,
      secretAccessKey: d.objectSecretAccessKey,
      cache: d.bundleCache,
      env: d.objectEnv,
    });
}

function parseBody(req) {
  let raw = (req && req.body) != null ? req.body : '';
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function headerGet(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return '';
}

/**
 * @param {object} req
 * @returns {{ ok: true, req: object } | { ok: false, error: string }}
 */
function validateMcpRequest(req) {
  if (!req || typeof req !== 'object') return { ok: false, error: 'request_required' };
  if (!req.server || typeof req.server !== 'string') {
    return { ok: false, error: 'server_required' };
  }
  if (!req.version || typeof req.version !== 'string') {
    req.version = '1.0.0';
  }
  const action = req.action == null ? 'call' : req.action;
  if (action !== 'call' && action !== 'list') {
    return { ok: false, error: 'action_invalid' };
  }
  req.action = action;
  if (action === 'call') {
    if (!req.tool || typeof req.tool !== 'string') {
      return { ok: false, error: 'tool_required' };
    }
  }
  const principal = req.principal;
  if (!principal || typeof principal !== 'object') {
    return { ok: false, error: 'principal_required' };
  }
  if (!principal.id || typeof principal.id !== 'string') {
    return { ok: false, error: 'principal_id_required' };
  }
  if (!principal.tenant_id || typeof principal.tenant_id !== 'string') {
    return { ok: false, error: 'principal_tenant_id_required' };
  }
  if (req.bundle || req.bundle_uri || req.cfg || req.config || req.secrets) {
    return { ok: false, error: 'identifiers_only' };
  }
  return { ok: true, req };
}

async function invokeToolOnce(req, deps) {
  const d = deps || {};
  const v = validateMcpRequest(req);
  if (!v.ok) {
    const err = new Error(v.error);
    err.status = 400;
    throw err;
  }

  const resolve = d.resolve;
  if (typeof resolve !== 'function') {
    const err = new Error('resolve_rpc_required');
    err.status = 500;
    throw err;
  }

  const tenantId = req.principal.tenant_id;
  const resolved = await resolve({
    tenant_id: tenantId,
    kind: 'mcp',
    name: req.server,
    version: req.version,
    principal: req.principal,
  });
  if (resolved && resolved.secrets && typeof resolved.secrets === 'object') {
    const err = new Error('secrets_plaintext_forbidden');
    err.status = 500;
    throw err;
  }

  const cfg = (resolved && resolved.cfg) || {};
  const factory = await buildFactory(cfg, {
    fetchImpl: d.fetchImpl,
    runTool: d.runTool,
    listTools: d.listTools,
    source: (resolved && resolved.source) || {},
    secrets_ref: (resolved && resolved.secrets_ref) || null,
    loadBundle: typeof d.loadBundle === 'function' ? d.loadBundle : defaultLoadBundle(tenantId, d),
  });

  if (req.action === 'list') {
    const listed = await factory.listTools({
      server: req.server,
      version: req.version,
      principal: req.principal,
      cfg,
      secrets_ref: (resolved && resolved.secrets_ref) || null,
    });
    return {
      ok: !(listed && listed.ok === false),
      action: 'list',
      tools: (listed && listed.tools) || [],
      result: listed,
      server: req.server,
      version: req.version,
      tool: null,
      tenant_id: tenantId,
    };
  }

  const result = await factory.runTool({
    server: req.server,
    version: req.version,
    tool: req.tool,
    arguments: req.arguments && typeof req.arguments === 'object' ? req.arguments : {},
    principal: req.principal,
    cfg,
    secrets_ref: (resolved && resolved.secrets_ref) || null,
  });

  return {
    ok: !(result && result.ok === false),
    action: 'call',
    result: result == null ? {} : result,
    server: req.server,
    version: req.version,
    tool: req.tool,
    tenant_id: tenantId,
  };
}

async function handleTask(req, deps) {
  try {
    const out = await invokeToolOnce(req, deps);
    const id =
      (req && typeof req.id === 'string' && req.id) ||
      `mcp-${Date.now().toString(36)}`;
    const payload =
      out.action === 'list'
        ? {
            server: out.server,
            version: out.version,
            action: 'list',
            tools: out.tools,
          }
        : {
            server: out.server,
            version: out.version,
            action: 'call',
            tool: out.tool,
            result: out.result,
          };
    return {
      status: 200,
      body: JSON.stringify({
        id,
        type: 'mcp.invoke.done',
        tenant_id: out.tenant_id,
        occurred_at: new Date().toISOString(),
        payload,
        content_ref: null,
      }),
    };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.message || 'mcp_invoke_failed',
        type: 'mcp.invoke.error',
      }),
    };
  }
}

async function handleRpc(req, deps) {
  try {
    const out = await invokeToolOnce(req, deps);
    if (out.action === 'list') {
      return {
        status: 200,
        body: JSON.stringify({
          type: 'mcp.tool.done',
          ok: out.ok,
          action: 'list',
          server: out.server,
          version: out.version,
          tools: out.tools,
          subject: 'aura.rpc.mcp.tool',
        }),
      };
    }
    return {
      status: 200,
      body: JSON.stringify({
        type: 'mcp.tool.done',
        ok: out.ok,
        action: 'call',
        server: out.server,
        version: out.version,
        tool: out.tool,
        result: out.result,
        subject: 'aura.rpc.mcp.tool',
      }),
    };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        type: 'mcp.tool.error',
        ok: false,
        error: err.message || 'mcp_tool_failed',
        subject: 'aura.rpc.mcp.tool',
      }),
    };
  }
}

function isRpcContext(context) {
  const req = context && context.request;
  const h = headerGet(req && req.headers, 'x-aura-rpc');
  if (h === 'aura.rpc.mcp.tool' || h === 'mcp.tool') return true;
  if (context && context.rpcSubject === 'aura.rpc.mcp.tool') return true;
  if (context && context.mode === 'rpc') return true;
  return false;
}

module.exports = async function (context) {
  let req;
  try {
    req = parseBody(context && context.request);
  } catch (err) {
    const rpc = isRpcContext(context);
    return {
      status: 400,
      body: JSON.stringify({
        error: 'invalid_json',
        detail: String(err && err.message),
        type: rpc ? 'mcp.tool.error' : 'mcp.invoke.error',
        ok: rpc ? false : undefined,
      }),
    };
  }

  const deps = {
    resolve: context && context.resolve,
    runTool: context && context.runTool,
    listTools: context && context.listTools,
    fetchImpl: context && context.fetchImpl,
  };

  if (!deps.resolve) {
    deps.resolve = async (r) => ({
      type: 'control.resolve.done',
      cfg: {},
      secrets_ref: null,
      source: { name: r.name, version: r.version },
    });
  }

  if (isRpcContext(context)) {
    return handleRpc(req, deps);
  }
  return handleTask(req, deps);
};

module.exports.validateMcpRequest = validateMcpRequest;
module.exports.invokeToolOnce = invokeToolOnce;
module.exports.handleTask = handleTask;
module.exports.handleRpc = handleRpc;
module.exports.isRpcContext = isRpcContext;
module.exports.buildFactory = buildFactory;
