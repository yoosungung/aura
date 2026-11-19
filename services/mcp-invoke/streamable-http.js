'use strict';

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

/**
 * @param {{ id?: string|number }} opts
 */
function buildToolsListRequest(opts) {
  const reqId = opts && opts.id != null ? opts.id : nextRequestId();
  return {
    id: reqId,
    body: {
      jsonrpc: JSONRPC_VERSION,
      id: reqId,
      method: 'tools/list',
      params: {},
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
async function postJsonRpc(opts, built) {
  const o = opts || {};
  const fetchFn = o.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'fetch_required' };
  }
  if (!o.endpoint || typeof o.endpoint !== 'string') {
    return { ok: false, error: 'endpoint_required' };
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
  return { ok: true, message: msg, result: msg.result != null ? msg.result : {} };
}

async function callToolViaStreamableHttp(opts) {
  const o = opts || {};
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
  const out = await postJsonRpc(o, built);
  if (!out.ok) return out;
  return { ok: true, result: out.result };
}

/**
 * @param {{ endpoint: string, sessionId?: string, protocolVersion?: string, fetchImpl?: Function, id?: string|number }} opts
 */
async function listToolsViaStreamableHttp(opts) {
  const o = opts || {};
  const built = buildToolsListRequest({ id: o.id });
  const out = await postJsonRpc(o, built);
  if (!out.ok) return out;
  const tools =
    out.result && Array.isArray(out.result.tools)
      ? out.result.tools
      : Array.isArray(out.result)
        ? out.result
        : [];
  return { ok: true, tools };
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  buildToolsCallRequest,
  buildToolsListRequest,
  parseJsonOrSseResponse,
  callToolViaStreamableHttp,
  listToolsViaStreamableHttp,
};
