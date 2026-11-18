'use strict';

/**
 * mcp_invoke dual entry — ARCHITECTURE §1 #10·#11·#12 · §3.2 · §3.3 · §7 · §8.
 *
 * Async MQT:  aura.tasks.mcp.invoke → HTTP 200 body → aura.events.mcp.invoke.done
 * Sync RPC:   aura.rpc.mcp.tool     → mcp.tool.done (Core RR; minReplicas ≥ 2)
 *
 * Zero Direct Write: no memory_* PG. Identifiers only; resolve → factory(cfg, secrets_ref).
 * Non-goals (this slice): live Streamable HTTP adapter · sandbox/egress · live NATS Core
 * subscribe wiring · control resolve bridge Deployment · live LLM.
 */

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
  if (!req.tool || typeof req.tool !== 'string') {
    return { ok: false, error: 'tool_required' };
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
  // Identifiers only — reject accidental bundle/config dumps (§1 #11).
  if (req.bundle || req.bundle_uri || req.cfg || req.config || req.secrets) {
    return { ok: false, error: 'identifiers_only' };
  }
  return { ok: true, req };
}

/** Deterministic stub factory — echoes arguments (no live MCP protocol / HTTP adapter). */
async function defaultRunTool(ctx) {
  return {
    ok: true,
    echo: ctx.arguments && typeof ctx.arguments === 'object' ? ctx.arguments : {},
    mode: 'stub',
  };
}

/**
 * Shared tool path: resolve → runTool (injectable).
 * @param {object} req
 * @param {object} deps
 */
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

  const runTool = d.runTool || defaultRunTool;
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

  const result = await runTool({
    server: req.server,
    version: req.version,
    tool: req.tool,
    arguments: req.arguments && typeof req.arguments === 'object' ? req.arguments : {},
    principal: req.principal,
    cfg: (resolved && resolved.cfg) || {},
    secrets_ref: (resolved && resolved.secrets_ref) || null,
  });

  return {
    ok: !(result && result.ok === false),
    result: result == null ? {} : result,
    server: req.server,
    version: req.version,
    tool: req.tool,
    tenant_id: tenantId,
  };
}

/**
 * Async MQT path — success body becomes aura.events.mcp.invoke.done.
 */
async function handleTask(req, deps) {
  try {
    const out = await invokeToolOnce(req, deps);
    const id =
      (req && typeof req.id === 'string' && req.id) ||
      `mcp-${Date.now().toString(36)}`;
    return {
      status: 200,
      body: JSON.stringify({
        id,
        type: 'mcp.invoke.done',
        tenant_id: out.tenant_id,
        occurred_at: new Date().toISOString(),
        payload: {
          server: out.server,
          version: out.version,
          tool: out.tool,
          result: out.result,
        },
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

/**
 * Sync RPC path — aura.rpc.mcp.tool reply body (mcp.tool.done).
 */
async function handleRpc(req, deps) {
  try {
    const out = await invokeToolOnce(req, deps);
    return {
      status: 200,
      body: JSON.stringify({
        type: 'mcp.tool.done',
        ok: out.ok,
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
  };

  // Default in-process stubs so Package literal can load without NATS (live RR = Non-goal).
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
module.exports.defaultRunTool = defaultRunTool;
module.exports.isRpcContext = isRpcContext;
