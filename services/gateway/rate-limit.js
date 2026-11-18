'use strict';

/**
 * Tenant Fair Queue / Rate Limit — Token Bucket + max_inflight (ARCHITECTURE §2.2).
 * Store is KV-shaped (`get`/`put`); tests use memory. Production = NATS JetStream KV.
 */

/** M3 DESIGN defaults (§2.2 draft). */
const DEFAULT_PLAN = Object.freeze({
  rate_per_sec: 10,
  burst: 30,
  max_inflight: 20,
});

/**
 * In-memory quota store (NATS KV stand-in).
 * @returns {{ get(key): Promise<any|null>, put(key, value): Promise<void> }}
 */
function createMemoryQuotaStore() {
  /** @type {Map<string, any>} */
  const map = new Map();
  return {
    async get(key) {
      if (!map.has(key)) return null;
      return JSON.parse(JSON.stringify(map.get(key)));
    },
    async put(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    size() {
      return map.size;
    },
  };
}

function quotaKey(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenant_id_required');
  }
  return `quota:${tenantId}`;
}

function normalizePlan(plan) {
  const p = plan && typeof plan === 'object' ? plan : {};
  const rate_per_sec = p.rate_per_sec != null ? Number(p.rate_per_sec) : DEFAULT_PLAN.rate_per_sec;
  const burst = p.burst != null ? Number(p.burst) : DEFAULT_PLAN.burst;
  const max_inflight = p.max_inflight != null ? Number(p.max_inflight) : DEFAULT_PLAN.max_inflight;
  if (!(rate_per_sec > 0) || !(burst >= 1) || !(max_inflight >= 1)) {
    throw new Error('plan_invalid');
  }
  return { rate_per_sec, burst, max_inflight };
}

function emptyState(burst, nowMs) {
  return {
    tokens: burst,
    updated_at_ms: nowMs,
    inflight: 0,
    runs: {},
  };
}

function refill(state, nowMs, plan) {
  const elapsedMs = Math.max(0, nowMs - (state.updated_at_ms || 0));
  const added = (plan.rate_per_sec * elapsedMs) / 1000;
  const tokens = Math.min(plan.burst, (state.tokens || 0) + added);
  return {
    tokens,
    updated_at_ms: nowMs,
    inflight: state.inflight || 0,
    runs: state.runs && typeof state.runs === 'object' ? { ...state.runs } : {},
  };
}

function retryAfterMs(state, plan) {
  if (state.inflight >= plan.max_inflight) return 1000;
  if (state.tokens >= 1) return 1;
  const need = 1 - state.tokens;
  return Math.max(1, Math.ceil((need / plan.rate_per_sec) * 1000));
}

/**
 * Reserve 1 token + 1 inflight slot for runId.
 */
async function acquireForRun(tenantId, runId, opts) {
  const o = opts || {};
  const store = o.store;
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new Error('quota_store_required');
  }
  if (!runId || typeof runId !== 'string') {
    return { ok: false, error: 'run_id_required', status: 400, retry_after_ms: 1 };
  }
  const plan = normalizePlan(o.plan);
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const key = quotaKey(tenantId);

  const raw = await store.get(key);
  let state = raw
    ? refill(
        {
          tokens: typeof raw.tokens === 'number' ? raw.tokens : plan.burst,
          updated_at_ms: typeof raw.updated_at_ms === 'number' ? raw.updated_at_ms : nowMs,
          inflight: typeof raw.inflight === 'number' ? raw.inflight : 0,
          runs: raw.runs && typeof raw.runs === 'object' ? raw.runs : {},
        },
        nowMs,
        plan,
      )
    : emptyState(plan.burst, nowMs);

  if (state.runs[runId]) {
    return { ok: true };
  }

  if (state.tokens < 1) {
    return {
      ok: false,
      error: 'rate_limited',
      status: 429,
      retry_after_ms: retryAfterMs(state, plan),
    };
  }
  if (state.inflight >= plan.max_inflight) {
    return {
      ok: false,
      error: 'max_inflight_exceeded',
      status: 429,
      retry_after_ms: retryAfterMs(state, plan),
    };
  }

  state.tokens -= 1;
  state.inflight += 1;
  state.runs[runId] = true;
  state.updated_at_ms = nowMs;
  await store.put(key, state);
  return { ok: true };
}

/**
 * Release inflight for runId (idempotent).
 */
async function releaseInflight(tenantId, runId, opts) {
  const o = opts || {};
  const store = o.store;
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new Error('quota_store_required');
  }
  const plan = normalizePlan(o.plan);
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const key = quotaKey(tenantId);
  const raw = await store.get(key);
  if (!raw) {
    return { ok: true, released: false };
  }
  let state = refill(
    {
      tokens: typeof raw.tokens === 'number' ? raw.tokens : plan.burst,
      updated_at_ms: typeof raw.updated_at_ms === 'number' ? raw.updated_at_ms : nowMs,
      inflight: typeof raw.inflight === 'number' ? raw.inflight : 0,
      runs: raw.runs && typeof raw.runs === 'object' ? { ...raw.runs } : {},
    },
    nowMs,
    plan,
  );

  if (!state.runs[runId]) {
    return { ok: true, released: false };
  }
  delete state.runs[runId];
  state.inflight = Math.max(0, state.inflight - 1);
  state.updated_at_ms = nowMs;
  await store.put(key, state);
  return { ok: true, released: true };
}

module.exports = {
  DEFAULT_PLAN,
  createMemoryQuotaStore,
  acquireForRun,
  releaseInflight,
  quotaKey,
};
