'use strict';

/**
 * Gateway — run_id 발급 · aura.stream.<run_id> → SSE/WS 브리지 · principal 인가
 * · tenant Fair Queue / Rate Limit (ARCHITECTURE §1 #1·#13·#16 · §2 · §2.2 · §3.5 · §7).
 *
 * Non-goals: live NATS JetStream KV client · F1 subject sharding · live LLM · sandbox · mcp_invoke.
 */

const crypto = require('crypto');
const {
  DEFAULT_LIMITS,
  createMemoryKv,
  createTenantRateLimiter,
  isTerminalStreamFrame,
  isTerminalInvokeEvent,
} = require('./rate-limit');

const TASK_AGENT_INVOKE = 'aura.tasks.agent.invoke';
const STREAM_PREFIX = 'aura.stream.';

const STREAM_FRAME_TYPES = Object.freeze([
  'run.started',
  'token',
  'tool.started',
  'tool.finished',
  'error',
  'run.completed',
]);

function issueRunId(nowMs) {
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(ms);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuidV7(id) {
  if (typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function buildStreamSubject(runId) {
  if (!runId || typeof runId !== 'string') throw new Error('run_id_required');
  if (runId.includes('*') || runId.includes('>') || runId.includes('.')) {
    throw new Error('run_id_invalid');
  }
  return `${STREAM_PREFIX}${runId}`;
}

function assertExactStreamSubject(subject, runId) {
  const expected = buildStreamSubject(runId);
  if (subject !== expected) {
    const err = new Error('stream_subject_mismatch');
    err.status = 400;
    throw err;
  }
  if (subject.includes('*') || subject.includes('>')) {
    const err = new Error('stream_wildcard_forbidden');
    err.status = 400;
    throw err;
  }
  return expected;
}

function validatePrincipal(principal) {
  if (!principal || typeof principal !== 'object') {
    return { ok: false, error: 'principal_required' };
  }
  if (!principal.id || typeof principal.id !== 'string') {
    return { ok: false, error: 'principal_id_required' };
  }
  if (!principal.tenant_id || typeof principal.tenant_id !== 'string') {
    return { ok: false, error: 'principal_tenant_id_required' };
  }
  return { ok: true, principal };
}

function createRunRegistry() {
  /** @type {Map<string, { principal_id: string, tenant_id: string, created_at: string }>} */
  const runs = new Map();
  return {
    register(runId, principal) {
      const v = validatePrincipal(principal);
      if (!v.ok) {
        const err = new Error(v.error);
        err.status = 401;
        throw err;
      }
      if (!runId || typeof runId !== 'string') {
        const err = new Error('run_id_required');
        err.status = 400;
        throw err;
      }
      runs.set(runId, {
        principal_id: principal.id,
        tenant_id: principal.tenant_id,
        created_at: new Date().toISOString(),
      });
      return runs.get(runId);
    },
    get(runId) {
      return runs.get(runId) || null;
    },
    authorize(runId, principal) {
      const v = validatePrincipal(principal);
      if (!v.ok) return { ok: false, error: v.error, status: 401 };
      const owned = runs.get(runId);
      if (!owned) return { ok: false, error: 'run_not_found', status: 404 };
      if (owned.principal_id !== principal.id) {
        return { ok: false, error: 'principal_forbidden', status: 403 };
      }
      if (owned.tenant_id !== principal.tenant_id) {
        return { ok: false, error: 'tenant_forbidden', status: 403 };
      }
      return { ok: true };
    },
    size() {
      return runs.size;
    },
  };
}

/**
 * Submit: mint run_id → quota acquire → register → publish.
 * Reject → 429, no JetStream publish (§2.2).
 */
async function submitAgentInvoke(body, principal, deps) {
  const d = deps || {};
  const registry = d.registry;
  const publishTask = d.publishTask;
  if (!registry) {
    const err = new Error('registry_required');
    err.status = 500;
    throw err;
  }
  if (typeof publishTask !== 'function') {
    const err = new Error('publish_task_required');
    err.status = 500;
    throw err;
  }

  const pv = validatePrincipal(principal);
  if (!pv.ok) {
    const err = new Error(pv.error);
    err.status = 401;
    throw err;
  }

  const req = body && typeof body === 'object' ? body : {};
  if (!req.agent || typeof req.agent !== 'string') {
    const err = new Error('agent_required');
    err.status = 400;
    throw err;
  }
  if (!req.version || typeof req.version !== 'string') {
    const err = new Error('version_required');
    err.status = 400;
    throw err;
  }
  if (req.bundle || req.bundle_uri || req.cfg || req.config || req.secrets) {
    const err = new Error('identifiers_only');
    err.status = 400;
    throw err;
  }

  const mint = typeof d.issueRunId === 'function' ? d.issueRunId : issueRunId;
  const runId = mint();
  if (!isUuidV7(runId)) {
    const err = new Error('run_id_not_uuidv7');
    err.status = 500;
    throw err;
  }

  const rateLimiter =
    d.rateLimiter ||
    createTenantRateLimiter({
      kv: d.kv || createMemoryKv(),
      limits: d.limits,
      now:
        typeof d.nowMs === 'number'
          ? () => d.nowMs
          : typeof d.now === 'function'
            ? d.now
            : undefined,
    });
  const admitted = await rateLimiter.tryAcquire(principal.tenant_id, runId);
  if (!admitted.ok) {
    const err = new Error(admitted.error);
    err.status = admitted.status || 429;
    err.retry_after_ms = admitted.retry_after_ms;
    throw err;
  }

  registry.register(runId, principal);

  const stream = req.stream !== false;
  const task = {
    run_id: runId,
    agent: req.agent,
    version: req.version,
    input: req.input && typeof req.input === 'object' ? req.input : {},
    session_id: req.session_id || null,
    stream,
    principal: { id: principal.id, tenant_id: principal.tenant_id },
  };

  try {
    await publishTask(TASK_AGENT_INVOKE, task);
  } catch (pubErr) {
    await rateLimiter.release(principal.tenant_id, runId);
    throw pubErr;
  }

  return {
    run_id: runId,
    stream,
    stream_subject: buildStreamSubject(runId),
    agent: req.agent,
    version: req.version,
  };
}

async function openStreamBridge(runId, principal, deps, onFrame) {
  const d = deps || {};
  const registry = d.registry;
  const subscribeStream = d.subscribeStream;
  const rateLimiter = d.rateLimiter;
  if (!registry) {
    const err = new Error('registry_required');
    err.status = 500;
    throw err;
  }
  if (typeof subscribeStream !== 'function') {
    const err = new Error('subscribe_stream_required');
    err.status = 500;
    throw err;
  }
  if (typeof onFrame !== 'function') {
    const err = new Error('on_frame_required');
    err.status = 500;
    throw err;
  }

  const auth = registry.authorize(runId, principal);
  if (!auth.ok) {
    const err = new Error(auth.error);
    err.status = auth.status;
    throw err;
  }

  const owned = registry.get(runId);
  const subject = assertExactStreamSubject(buildStreamSubject(runId), runId);
  let released = false;

  const sub = await subscribeStream(subject, async (raw) => {
    let frame = raw;
    if (typeof raw === 'string') {
      try {
        frame = JSON.parse(raw);
      } catch {
        frame = { type: 'error', message: 'invalid_frame_json' };
      }
    }
    if (!frame || typeof frame !== 'object') {
      frame = { type: 'error', message: 'invalid_frame' };
    }
    await onFrame(frame);
    if (!released && rateLimiter && owned && isTerminalStreamFrame(frame)) {
      released = true;
      await rateLimiter.release(owned.tenant_id, runId);
    }
  });

  return {
    run_id: runId,
    subject,
    close: async () => {
      if (sub && typeof sub.close === 'function') await sub.close();
    },
  };
}

async function releaseInflightFromEvent(subject, tenantId, runId, deps) {
  if (!isTerminalInvokeEvent(subject)) {
    return { ok: true, released: false, skipped: true };
  }
  const d = deps || {};
  const rateLimiter =
    d.rateLimiter ||
    createTenantRateLimiter({
      kv: d.kv || createMemoryKv(),
      limits: d.limits,
      now: typeof d.now === 'function' ? d.now : undefined,
    });
  return rateLimiter.release(tenantId, runId);
}

function formatSseFrame(frame) {
  const payload = JSON.stringify(frame && typeof frame === 'object' ? frame : {});
  return `data: ${payload}\n\n`;
}

function authorizeWs(runId, principal, registry) {
  if (!registry) return { ok: false, error: 'registry_required', status: 500 };
  const auth = registry.authorize(runId, principal);
  if (!auth.ok) return auth;
  try {
    const subject = assertExactStreamSubject(buildStreamSubject(runId), runId);
    return { ok: true, subject };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status || 400 };
  }
}

async function handleSubmitHttp(request, deps) {
  const principal = request && request.principal;
  let body = request && request.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }
  }
  try {
    const out = await submitAgentInvoke(body, principal, deps);
    return { status: 202, body: out };
  } catch (err) {
    const bodyOut = { error: err.message || 'submit_failed' };
    if (err.status === 429 && err.retry_after_ms != null) {
      bodyOut.retry_after_ms = err.retry_after_ms;
    }
    return { status: err.status || 500, body: bodyOut };
  }
}

async function handleSseHttp(request, deps) {
  const runId = request && request.run_id;
  const principal = request && request.principal;
  const frames = [];
  try {
    const bridge = await openStreamBridge(runId, principal, deps, async (frame) => {
      frames.push(formatSseFrame(frame));
    });
    return { status: 200, bridge, frames, contentType: 'text/event-stream' };
  } catch (err) {
    return { status: err.status || 500, body: { error: err.message || 'sse_failed' } };
  }
}

module.exports = {
  issueRunId,
  isUuidV7,
  buildStreamSubject,
  assertExactStreamSubject,
  validatePrincipal,
  createRunRegistry,
  submitAgentInvoke,
  openStreamBridge,
  formatSseFrame,
  authorizeWs,
  handleSubmitHttp,
  handleSseHttp,
  releaseInflightFromEvent,
  isTerminalStreamFrame,
  isTerminalInvokeEvent,
  TASK_AGENT_INVOKE,
  STREAM_PREFIX,
  STREAM_FRAME_TYPES,
  DEFAULT_LIMITS,
  createMemoryKv,
  createTenantRateLimiter,
};
