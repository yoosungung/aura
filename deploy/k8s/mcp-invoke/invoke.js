'use strict';

/**
 * Fission Package entry for mcp_invoke (ARCHITECTURE §1 #10·#11·#12 · §3.2 · §3.3).
 * Source of truth: services/mcp-invoke/handler.js + streamable-http.js
 * Single-file literal (streamable-http inlined). PG forbidden.
 */


/**
 * MCP Spec 2025-06-18 Streamable HTTP client — mcp_invoke Function boundary only.
 * Injectable fetch; no plaintext secret logging (no console of credentials).
 */

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const JSONRPC_VERSION = '2.0';

function nextRequestId() {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param {{ tool: string, arguments?: object, id?: string|number }} opts
 */
function buildToolsCallRequest(opts) {
  const tool = opts && opts.tool;
  if (!tool || typeof tool !== 'string') {
    throw new Error('tool_required');
  }
  const reqId = opts && opts.id != null ? opts.id : nextRequestId();
  const args =
    opts && opts.arguments && typeof opts.arguments === 'object'
      ? opts.arguments
      : {};
  return {
    id: reqId,
    body: {
      jsonrpc: JSONRPC_VERSION,
      id: reqId,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
  };
}

function tryParseJsonRpc(line) {
  const s = String(line).trim();
  if (!s) return null;
  try {
    const msg = JSON.parse(s);
    if (msg && typeof msg === 'object' && msg.jsonrpc === JSONRPC_VERSION) {
      return msg;
    }
  } catch (_) {
    /* ignore partial SSE chunks */
  }
  return null;
}

/**
 * @param {{ bodyText: string, contentType?: string, wantId?: string|number }} opts
 * @returns {{ ok: true, message: object } | { ok: false, error: string }}
 */
function parseJsonOrSseResponse(opts) {
  const bodyText = (opts && opts.bodyText) != null ? String(opts.bodyText) : '';
  const contentType = String((opts && opts.contentType) || '').toLowerCase();
  const wantId = opts && opts.wantId;

  if (!bodyText.trim()) {
    return { ok: false, error: 'empty_response_body' };
  }

  const isSse =
    contentType.includes('text/event-stream') ||
    (!contentType.includes('application/json') &&
      /(^|\n)\s*data:\s*/m.test(bodyText));

  if (!isSse) {
    let msg;
    try {
      msg = JSON.parse(bodyText);
    } catch (err) {
      return { ok: false, error: 'invalid_json_body' };
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== JSONRPC_VERSION) {
      return { ok: false, error: 'invalid_jsonrpc_response' };
    }
    if (wantId != null && msg.id !== wantId) {
      return { ok: false, error: 'jsonrpc_id_mismatch' };
    }
    return { ok: true, message: msg };
  }

  const messages = [];
  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    const msg = tryParseJsonRpc(payload);
    if (msg) messages.push(msg);
  }

  if (messages.length === 0) {
    return { ok: false, error: 'no_sse_jsonrpc_messages' };
  }

  let chosen = null;
  if (wantId != null) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].id === wantId) {
        chosen = messages[i];
        break;
      }
    }
    if (!chosen) {
      return { ok: false, error: 'sse_id_not_found' };
    }
  } else {
    chosen = messages[messages.length - 1];
  }

  return { ok: true, message: chosen };
}

function headerContentType(res) {
  if (!res || !res.headers) return '';
  if (typeof res.headers.get === 'function') {
    return res.headers.get('content-type') || '';
  }
  const h = res.headers;
  return h['content-type'] || h['Content-Type'] || '';
}

/**
 * @param {{
 *   endpoint: string,
 *   tool: string,
 *   arguments?: object,
 *   sessionId?: string,
 *   protocolVersion?: string,
 *   fetchImpl?: typeof fetch,
 *   id?: string|number,
 * }} opts
 */
async function callToolViaStreamableHttp(opts) {
  const o = opts || {};
  const fetchFn = o.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'fetch_required' };
  }
  if (!o.endpoint || typeof o.endpoint !== 'string') {
    return { ok: false, error: 'endpoint_required' };
  }
  if (!o.tool || typeof o.tool !== 'string') {
    return { ok: false, error: 'tool_required' };
  }

  let built;
  try {
    built = buildToolsCallRequest({
      tool: o.tool,
      arguments: o.arguments,
      id: o.id,
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }

  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': o.protocolVersion || DEFAULT_PROTOCOL_VERSION,
  };
  if (o.sessionId && typeof o.sessionId === 'string') {
    headers['Mcp-Session-Id'] = o.sessionId;
  }

  let res;
  try {
    res = await fetchFn(o.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(built.body),
    });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }

  const bodyText =
    res && typeof res.text === 'function' ? await res.text() : '';
  const parsed = parseJsonOrSseResponse({
    bodyText,
    contentType: headerContentType(res),
    wantId: built.id,
  });
  if (!parsed.ok) {
    return parsed;
  }

  const msg = parsed.message;
  if (msg.error != null) {
    return { ok: false, error: msg.error };
  }
  return { ok: true, result: msg.result != null ? msg.result : {} };
}

'use strict';

/**
 * mcp_invoke dual entry — ARCHITECTURE §1 #10·#11·#12 · §3.2 · §3.3 · §7 · §8.
 *
 * Async MQT:  aura.tasks.mcp.invoke → HTTP 200 body → aura.events.mcp.invoke.done
 * Sync RPC:   aura.rpc.mcp.tool     → mcp.tool.done (Core RR; minReplicas ≥ 2)
 *
 * Zero Direct Write: no memory_* PG. Identifiers only; resolve → factory(cfg, secrets_ref).
 * Streamable HTTP: external MCP via injectable client when resolve cfg says so
 * ([`streamable-http.js`](streamable-http.js); Fission invoke.js = single-file bundle).
 * Non-goals (this slice): sandbox/egress · live NATS Core subscribe wiring ·
 * control resolve bridge Deployment · live LLM · full MCP initialize lifecycle.
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

function buildStreamableRunTool(cfg, fetchImpl) {
  const endpoint = streamableEndpointFromCfg(cfg);
  const sessionId =
    typeof cfg.mcp_session_id === 'string'
      ? cfg.mcp_session_id
      : typeof cfg.session_id === 'string'
        ? cfg.session_id
        : undefined;
  const protocolVersion =
    typeof cfg.mcp_protocol_version === 'string'
      ? cfg.mcp_protocol_version
      : undefined;
  return async (ctx) => {
    const out = await callToolViaStreamableHttp({
      endpoint,
      tool: ctx.tool,
      arguments: ctx.arguments,
      sessionId,
      protocolVersion,
      fetchImpl,
    });
    if (!out.ok) return out;
    const payload =
      out.result && typeof out.result === 'object' ? out.result : { value: out.result };
    return { ok: true, mode: 'streamable_http', ...payload };
  };
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
  let runTool = d.runTool;
  if (!runTool) {
    if (cfgUsesStreamableHttp(cfg)) {
      const ep = streamableEndpointFromCfg(cfg);
      if (!ep) {
        const err = new Error('mcp_endpoint_required');
        err.status = 500;
        throw err;
      }
      runTool = buildStreamableRunTool(cfg, d.fetchImpl);
    } else {
      runTool = defaultRunTool;
    }
  }

  const result = await runTool({
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
    fetchImpl: context && context.fetchImpl,
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
module.exports.cfgUsesStreamableHttp = cfgUsesStreamableHttp;
module.exports.buildStreamableRunTool = buildStreamableRunTool;
