'use strict';

/**
 * Fission MQT handler — aura.tasks.agent.invoke (ARCHITECTURE §1 #10·#13 · §3.2 · §3.5 · §7).
 * Zero Direct Write: no memory_* PG. Stream frames → aura.stream.<run_id> (Core, lossy).
 * Done 정본 → HTTP 200 body → MQT respTopic aura.events.agent.invoke.done.
 *
 * Non-goals (this slice): Gateway SSE/WS · Fair Queue · live LLM Gateway HTTP ·
 * live NATS Core client wiring · mcp_invoke Function · control resolve bridge Deployment ·
 * agent_checkpoints DDL.
 */

const SHORT_TERM_ITEM_CAP = 4;
const TOKEN_BUDGET = {
  short_term: 512,
  episodic: 768,
  long_term_semantic: 768,
};

const STREAM_FRAME_TYPES = Object.freeze([
  'run.started',
  'token',
  'tool.started',
  'tool.finished',
  'error',
  'run.completed',
]);

function parseBody(req) {
  let raw = (req && req.body) != null ? req.body : '';
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function estimateTokens(text) {
  const s = typeof text === 'string' ? text : '';
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 4);
}

function buildStreamSubject(runId) {
  return `aura.stream.${runId}`;
}

/**
 * @param {object} task
 * @returns {{ ok: true, task: object } | { ok: false, error: string }}
 */
function validateInvokeTask(task) {
  if (!task || typeof task !== 'object') return { ok: false, error: 'task_required' };
  if (!task.run_id || typeof task.run_id !== 'string') {
    return { ok: false, error: 'run_id_required' };
  }
  if (!task.agent || typeof task.agent !== 'string') {
    return { ok: false, error: 'agent_required' };
  }
  if (!task.version || typeof task.version !== 'string') {
    return { ok: false, error: 'version_required' };
  }
  const principal = task.principal;
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
  if (task.bundle || task.bundle_uri || task.cfg || task.config || task.secrets) {
    return { ok: false, error: 'identifiers_only' };
  }
  return { ok: true, task };
}

/**
 * Pack recall items[] into inject slots (agent-inject-contract). No spill across slots.
 * @param {Array<object>} items
 */
function packRecallItems(items) {
  const list = Array.isArray(items) ? items : [];
  const short_term = [];
  const episodic = [];
  const long_term_semantic = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const mt = item.memory_type;
    const content = typeof item.content === 'string' ? item.content : '';
    if (!content) continue;
    if (mt === 'short_term') {
      if (short_term.length < SHORT_TERM_ITEM_CAP) short_term.push(item);
    } else if (mt === 'episodic') {
      episodic.push(item);
    } else if (mt === 'long_term' || mt === 'semantic') {
      long_term_semantic.push(item);
    }
  }

  function trimByBudget(arr, budget) {
    const out = [];
    let used = 0;
    for (const it of arr) {
      const t = estimateTokens(it.content);
      if (used + t > budget) break;
      out.push(it);
      used += t;
    }
    return out;
  }

  return {
    short_term: trimByBudget(short_term, TOKEN_BUDGET.short_term),
    episodic: trimByBudget(episodic, TOKEN_BUDGET.episodic),
    long_term_semantic: trimByBudget(
      long_term_semantic,
      TOKEN_BUDGET.long_term_semantic,
    ),
  };
}

function packedContextText(packed) {
  const parts = [];
  for (const it of packed.short_term) parts.push(it.content);
  for (const it of packed.episodic) parts.push(it.content);
  for (const it of packed.long_term_semantic) parts.push(it.content);
  return parts.join('\n');
}

async function noopPublish() {}

/**
 * Deterministic turn stub (no live LLM). Emits tokens; optional tool from input.tool.
 */
async function defaultRunTurn(ctx) {
  const inputText =
    ctx.input && typeof ctx.input.text === 'string' ? ctx.input.text : '';
  const reply = ctx.memoryText
    ? `ack:${inputText || 'ok'}|mem:${ctx.memoryText.slice(0, 64)}`
    : `ack:${inputText || 'ok'}`;

  if (ctx.stream && ctx.publishStream) {
    // Slim incremental tokens (ARCHITECTURE §3.5).
    const chunk = reply.length > 24 ? reply.slice(0, 24) : reply;
    await ctx.publishStream(ctx.run_id, { type: 'token', text: chunk });
    if (reply.length > 24) {
      await ctx.publishStream(ctx.run_id, { type: 'token', text: reply.slice(24) });
    }
  }

  let toolResult = null;
  const toolReq = ctx.input && ctx.input.tool;
  if (toolReq && ctx.mcpTool) {
    const server = toolReq.server || 'default';
    const tool = toolReq.name || toolReq.tool;
    if (ctx.stream && ctx.publishStream) {
      await ctx.publishStream(ctx.run_id, {
        type: 'tool.started',
        tool,
        server,
      });
    }
    toolResult = await ctx.mcpTool({
      server,
      version: toolReq.version || '1.0.0',
      tool,
      arguments: toolReq.arguments || {},
      principal: ctx.principal,
    });
    if (ctx.stream && ctx.publishStream) {
      await ctx.publishStream(ctx.run_id, {
        type: 'tool.finished',
        tool,
        server,
        summary: toolResult && toolResult.ok === false ? 'error' : 'ok',
      });
    }
  }

  return { text: reply, toolResult };
}

/**
 * @param {object} task
 * @param {object} deps
 */
async function invokeOnce(task, deps) {
  const d = deps || {};
  const v = validateInvokeTask(task);
  if (!v.ok) {
    const err = new Error(v.error);
    err.status = 400;
    throw err;
  }

  const stream = task.stream !== false;
  const publishStream = d.publishStream || noopPublish;
  const resolve = d.resolve;
  const recall = d.recall;
  const mcpTool = d.mcpTool;
  const runTurn = d.runTurn || defaultRunTurn;

  if (typeof resolve !== 'function') {
    const err = new Error('resolve_rpc_required');
    err.status = 500;
    throw err;
  }
  if (typeof recall !== 'function') {
    const err = new Error('recall_rpc_required');
    err.status = 500;
    throw err;
  }

  const tenantId = task.principal.tenant_id;

  const resolved = await resolve({
    tenant_id: tenantId,
    kind: 'agent',
    name: task.agent,
    version: task.version,
    principal: task.principal,
  });
  if (resolved && resolved.secrets && typeof resolved.secrets === 'object') {
    const err = new Error('secrets_plaintext_forbidden');
    err.status = 500;
    throw err;
  }

  if (stream) {
    await publishStream(task.run_id, {
      type: 'run.started',
      run_id: task.run_id,
      session_id: task.session_id || null,
      agent: task.agent,
      version: task.version,
    });
  }

  const recallRes = await recall({
    tenant_id: tenantId,
    session_id: task.session_id,
    query: (task.input && task.input.text) || '',
    principal: task.principal,
  });
  const packed = packRecallItems(recallRes && recallRes.items);
  const memoryText = packedContextText(packed);

  let turnOut;
  try {
    turnOut = await runTurn({
      run_id: task.run_id,
      agent: task.agent,
      version: task.version,
      session_id: task.session_id,
      input: task.input || {},
      principal: task.principal,
      cfg: (resolved && resolved.cfg) || {},
      secrets_ref: (resolved && resolved.secrets_ref) || null,
      packed,
      memoryText,
      stream,
      publishStream,
      mcpTool,
    });
  } catch (turnErr) {
    if (stream) {
      await publishStream(task.run_id, {
        type: 'error',
        message: String(turnErr && turnErr.message),
      });
    }
    throw turnErr;
  }

  if (stream) {
    await publishStream(task.run_id, { type: 'run.completed' });
  }

  return {
    id: task.run_id,
    type: 'agent.invoke.done',
    tenant_id: tenantId,
    occurred_at: new Date().toISOString(),
    payload: {
      run_id: task.run_id,
      session_id: task.session_id || null,
      agent: task.agent,
      version: task.version,
      stream,
      output: {
        text: (turnOut && turnOut.text) || '',
      },
    },
    content_ref: null,
  };
}

module.exports = async function (context) {
  let task;
  try {
    task = parseBody(context && context.request);
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({
        error: 'invalid_json',
        detail: String(err && err.message),
        type: 'agent.invoke.error',
      }),
    };
  }

  const deps = {
    resolve: context && context.resolve,
    recall: context && context.recall,
    mcpTool: context && context.mcpTool,
    publishStream: context && context.publishStream,
    runTurn: context && context.runTurn,
  };

  // Default in-process stubs so Package literal can load without NATS (live RR = Non-goal).
  if (!deps.resolve) {
    deps.resolve = async (req) => ({
      type: 'control.resolve.done',
      cfg: {},
      secrets_ref: null,
      source: { name: req.name, version: req.version },
    });
  }
  if (!deps.recall) {
    deps.recall = async () => ({ items: [] });
  }
  if (!deps.mcpTool) {
    deps.mcpTool = async (req) => ({ ok: true, result: { tool: req.tool } });
  }
  if (!deps.publishStream) {
    deps.publishStream = noopPublish;
  }

  try {
    const out = await invokeOnce(task, deps);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.message || 'invoke_failed',
        type: 'agent.invoke.error',
      }),
    };
  }
};

module.exports.validateInvokeTask = validateInvokeTask;
module.exports.packRecallItems = packRecallItems;
module.exports.estimateTokens = estimateTokens;
module.exports.buildStreamSubject = buildStreamSubject;
module.exports.invokeOnce = invokeOnce;
module.exports.STREAM_FRAME_TYPES = STREAM_FRAME_TYPES;
module.exports.defaultRunTurn = defaultRunTurn;
