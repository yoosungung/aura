'use strict';

/**
 * Tenant Fair Queue / Rate Limit — Token Bucket + max_inflight (ARCHITECTURE §2.2).
 * Store is CAS KV (`get` + `cas`); tests use memory. Production = NATS JetStream KV.
 */

/** M3 DESIGN defaults (§2.2 draft). */
const DEFAULT_LIMITS = Object.freeze({
  ratePerSec: 10,
  burst: 30,
  maxInflight: 20,
});

/**
 * In-memory CAS KV (NATS JetStream KV stand-in).
 * @returns {{ get(key): Promise<{ value, revision }|null>, cas(key, expectedRevision, value): Promise<{ ok: boolean, revision?: number }> }}
 */
function createMemoryKv() {
  /** @type {Map<string, { value: any, revision: number }>} */
  const map = new Map();
  return {
    async get(key) {
      if (!map.has(key)) return null;
      const entry = map.get(key);
      return {
        value: JSON.parse(JSON.stringify(entry.value)),
        revision: entry.revision,
      };
    },
    async cas(key, expectedRevision, value) {
      const cur = map.get(key);
      const curRev = cur ? cur.revision : 0;
      if (curRev !== expectedRevision) {
        return { ok: false };
      }
      const nextRev = expectedRevision + 1;
      map.set(key, {
        value: JSON.parse(JSON.stringify(value)),
        revision: nextRev,
      });
      return { ok: true, revision: nextRev };
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
  return `quota.${tenantId}`;
}

function normalizeLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  const ratePerSec =
    l.ratePerSec != null
      ? Number(l.ratePerSec)
      : l.rate_per_sec != null
        ? Number(l.rate_per_sec)
        : DEFAULT_LIMITS.ratePerSec;
  const burst = l.burst != null ? Number(l.burst) : DEFAULT_LIMITS.burst;
  const maxInflight =
    l.maxInflight != null
      ? Number(l.maxInflight)
      : l.max_inflight != null
        ? Number(l.max_inflight)
        : DEFAULT_LIMITS.maxInflight;
  if (!(ratePerSec > 0) || !(burst >= 1) || !(maxInflight >= 1)) {
    throw new Error('limits_invalid');
  }
  return { ratePerSec, burst, maxInflight };
}

function emptyState(burst, nowMs) {
  return {
    tokens: burst,
    updated_at_ms: nowMs,
    inflight: 0,
    runs: {},
  };
}

function refill(state, nowMs, limits) {
  const elapsedMs = Math.max(0, nowMs - (state.updated_at_ms || 0));
  const added = (limits.ratePerSec * elapsedMs) / 1000;
  const tokens = Math.min(limits.burst, (state.tokens || 0) + added);
  return {
    tokens,
    updated_at_ms: nowMs,
    inflight: state.inflight || 0,
    runs: state.runs && typeof state.runs === 'object' ? { ...state.runs } : {},
  };
}

function retryAfterMs(state, limits) {
  if (state.inflight >= limits.maxInflight) return 1000;
  if (state.tokens >= 1) return 1;
  const need = 1 - state.tokens;
  return Math.max(1, Math.ceil((need / limits.ratePerSec) * 1000));
}

const MAX_CAS_ATTEMPTS = 32;

/**
 * @param {{ kv, limits?, now?: () => number }} opts
 */
function createTenantRateLimiter(opts) {
  const o = opts || {};
  const kv = o.kv;
  if (!kv || typeof kv.get !== 'function' || typeof kv.cas !== 'function') {
    throw new Error('kv_required');
  }
  const limits = normalizeLimits(o.limits);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  async function tryAcquire(tenantId, runId) {
    if (!runId || typeof runId !== 'string') {
      return { ok: false, error: 'run_id_required', status: 400, retry_after_ms: 1 };
    }
    const key = quotaKey(tenantId);
    const nowMs = now();

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await kv.get(key);
      const revision = raw ? raw.revision : 0;
      const prev = raw ? raw.value : null;

      let state = prev
        ? refill(
            {
              tokens: typeof prev.tokens === 'number' ? prev.tokens : limits.burst,
              updated_at_ms:
                typeof prev.updated_at_ms === 'number' ? prev.updated_at_ms : nowMs,
              inflight: typeof prev.inflight === 'number' ? prev.inflight : 0,
              runs: prev.runs && typeof prev.runs === 'object' ? prev.runs : {},
            },
            nowMs,
            limits,
          )
        : emptyState(limits.burst, nowMs);

      if (state.runs[runId]) {
        return { ok: true };
      }

      if (state.tokens < 1) {
        return {
          ok: false,
          error: 'rate_limited',
          status: 429,
          retry_after_ms: retryAfterMs(state, limits),
        };
      }
      if (state.inflight >= limits.maxInflight) {
        return {
          ok: false,
          error: 'max_inflight_exceeded',
          status: 429,
          retry_after_ms: retryAfterMs(state, limits),
        };
      }

      state.tokens -= 1;
      state.inflight += 1;
      state.runs[runId] = true;
      state.updated_at_ms = nowMs;

      const cas = await kv.cas(key, revision, state);
      if (cas.ok) {
        return { ok: true };
      }
    }

    return {
      ok: false,
      error: 'quota_cas_contention',
      status: 503,
      retry_after_ms: 50,
    };
  }

  async function release(tenantId, runId) {
    if (!runId || typeof runId !== 'string') {
      return { ok: true, released: false };
    }
    const key = quotaKey(tenantId);
    const nowMs = now();

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await kv.get(key);
      if (!raw) {
        return { ok: true, released: false };
      }
      const revision = raw.revision;
      let state = refill(
        {
          tokens:
            typeof raw.value.tokens === 'number' ? raw.value.tokens : limits.burst,
          updated_at_ms:
            typeof raw.value.updated_at_ms === 'number' ? raw.value.updated_at_ms : nowMs,
          inflight: typeof raw.value.inflight === 'number' ? raw.value.inflight : 0,
          runs:
            raw.value.runs && typeof raw.value.runs === 'object'
              ? { ...raw.value.runs }
              : {},
        },
        nowMs,
        limits,
      );

      if (!state.runs[runId]) {
        return { ok: true, released: false };
      }
      delete state.runs[runId];
      state.inflight = Math.max(0, state.inflight - 1);
      state.updated_at_ms = nowMs;

      const cas = await kv.cas(key, revision, state);
      if (cas.ok) {
        return { ok: true, released: true };
      }
    }

    return { ok: false, released: false, error: 'quota_cas_contention' };
  }

  /**
   * Gateway-admitted run: `runs[run_id]` → ok without extra token.
   * Bypass publish: acquire quota or return 429 for agent_invoke poison path.
   */
  async function ensureAdmitted(tenantId, runId) {
    return tryAcquire(tenantId, runId);
  }

  /** Read-only snapshot for ops (Admin Phase 2 get). */
  async function peek(tenantId) {
    const key = quotaKey(tenantId);
    const nowMs = now();
    const raw = await kv.get(key);
    if (!raw) {
      const empty = emptyState(limits.burst, nowMs);
      return {
        ok: true,
        tenant_id: tenantId,
        present: false,
        tokens: empty.tokens,
        inflight: 0,
        limits: { ...limits },
        updated_at_ms: nowMs,
      };
    }
    const state = refill(
      {
        tokens: typeof raw.value.tokens === 'number' ? raw.value.tokens : limits.burst,
        updated_at_ms:
          typeof raw.value.updated_at_ms === 'number' ? raw.value.updated_at_ms : nowMs,
        inflight: typeof raw.value.inflight === 'number' ? raw.value.inflight : 0,
        runs: raw.value.runs && typeof raw.value.runs === 'object' ? raw.value.runs : {},
      },
      nowMs,
      limits
    );
    return {
      ok: true,
      tenant_id: tenantId,
      present: true,
      tokens: state.tokens,
      inflight: state.inflight,
      limits: { ...limits },
      updated_at_ms: state.updated_at_ms,
      run_count: Object.keys(state.runs).length,
    };
  }

  /** Clear KV counter for tenant (Admin Phase 2 reset). Does not change plan limits. */
  async function reset(tenantId) {
    const key = quotaKey(tenantId);
    const nowMs = now();
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await kv.get(key);
      const revision = raw ? raw.revision : 0;
      const next = emptyState(limits.burst, nowMs);
      const cas = await kv.cas(key, revision, next);
      if (cas.ok) {
        return { ok: true, tenant_id: tenantId, reset: true };
      }
    }
    return { ok: false, error: 'quota_cas_contention', tenant_id: tenantId };
  }

  return { tryAcquire, release, ensureAdmitted, peek, reset, kv, limits };
}

function isTerminalStreamFrame(frame) {
  return !!(frame && (frame.type === 'run.completed' || frame.type === 'error'));
}

function isTerminalInvokeEvent(subjectOrType) {
  if (!subjectOrType || typeof subjectOrType !== 'string') return false;
  return (
    subjectOrType === 'aura.events.agent.invoke.done' ||
    subjectOrType === 'aura.events.agent.invoke.error' ||
    subjectOrType === 'run.completed' ||
    subjectOrType === 'error'
  );
}

module.exports = {
  DEFAULT_LIMITS,
  createMemoryKv,
  createTenantRateLimiter,
  quotaKey,
  isTerminalStreamFrame,
  isTerminalInvokeEvent,
};