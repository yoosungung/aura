'use strict';

/**
 * Cluster LLM Gateway — sole Function→provider exit (ARCHITECTURE §9.4).
 * M3 최소: chat completions · tenant rate limit · circuit breaker · usage/cost log.
 * Non-goals: Fallback 모델 대시보드 · live provider 키 필수 CI · 가중치 서빙.
 */

const DEFAULT_LLM_LIMITS = Object.freeze({
  ratePerSec: 20,
  burst: 40,
});

/** Rough USD/1k tokens for stub cost logging (not billing SoR). */
const STUB_USD_PER_1K = 0.002;

/**
 * @param {{ content?: string, model?: string }} [opts]
 */
function createStubProvider(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const fixed = o.content != null ? String(o.content) : 'stub-completion';
  return {
    name: 'stub',
    /**
     * @param {{ model: string, messages: object[] }} req
     */
    async complete(req) {
      const model = (req && req.model) || o.model || 'aura-default';
      const prompt = Array.isArray(req && req.messages)
        ? req.messages.map((m) => (m && m.content) || '').join('\n')
        : '';
      const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4));
      const completionTokens = Math.max(1, Math.ceil(Buffer.byteLength(fixed, 'utf8') / 4));
      return {
        id: `chatcmpl-stub-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: fixed },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        provider: 'stub',
      };
    },
  };
}

function createUsageLog() {
  /** @type {object[]} */
  const entries = [];
  return {
    entries,
    /**
     * @param {object} row
     */
    record(row) {
      entries.push(Object.freeze({ ...row, at_ms: row.at_ms || Date.now() }));
    },
  };
}

/**
 * @param {{ failureThreshold?: number, cooldownMs?: number, now?: () => number }} [opts]
 */
function createCircuitBreaker(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const failureThreshold = o.failureThreshold != null ? Number(o.failureThreshold) : 3;
  const cooldownMs = o.cooldownMs != null ? Number(o.cooldownMs) : 30_000;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  /** @type {Map<string, { failures: number, openUntil: number }>} */
  const state = new Map();

  function key(name) {
    return name || 'default';
  }

  return {
    /**
     * @param {string} name
     * @returns {{ allow: boolean, reason?: string }}
     */
    allow(name) {
      const k = key(name);
      const s = state.get(k);
      if (!s) return { allow: true };
      if (s.openUntil && now() < s.openUntil) {
        return { allow: false, reason: 'circuit_open' };
      }
      // half-open: allow one probe after cooldown
      return { allow: true };
    },
    recordSuccess(name) {
      state.set(key(name), { failures: 0, openUntil: 0 });
    },
    recordFailure(name) {
      const k = key(name);
      const prev = state.get(k) || { failures: 0, openUntil: 0 };
      const failures = prev.failures + 1;
      const openUntil =
        failures >= failureThreshold ? now() + cooldownMs : 0;
      state.set(k, { failures, openUntil });
    },
  };
}

/**
 * Simple per-tenant token bucket (no inflight — LLM request is short-lived).
 * @param {{ ratePerSec: number, burst: number }} limits
 * @param {() => number} now
 */
function createTenantBucket(limits, now) {
  /** @type {Map<string, { tokens: number, updated_at_ms: number }>} */
  const map = new Map();
  return {
    /**
     * @param {string} tenantId
     * @returns {{ ok: true } | { ok: false, error: string }}
     */
    tryAcquire(tenantId) {
      if (!tenantId || typeof tenantId !== 'string') {
        return { ok: false, error: 'tenant_id_required' };
      }
      const t = now();
      let s = map.get(tenantId);
      if (!s) {
        s = { tokens: limits.burst, updated_at_ms: t };
      } else {
        const elapsed = Math.max(0, (t - s.updated_at_ms) / 1000);
        s.tokens = Math.min(
          limits.burst,
          s.tokens + elapsed * limits.ratePerSec,
        );
        s.updated_at_ms = t;
      }
      if (s.tokens < 1) {
        map.set(tenantId, s);
        return { ok: false, error: 'rate_limited' };
      }
      s.tokens -= 1;
      map.set(tenantId, s);
      return { ok: true };
    },
  };
}

function normalizeLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  const ratePerSec =
    l.ratePerSec != null ? Number(l.ratePerSec) : DEFAULT_LLM_LIMITS.ratePerSec;
  const burst = l.burst != null ? Number(l.burst) : DEFAULT_LLM_LIMITS.burst;
  if (!(ratePerSec > 0) || !(burst >= 1)) {
    throw new Error('limits_invalid');
  }
  return { ratePerSec, burst };
}

function estimateCostUsd(usage) {
  const total =
    (usage && usage.total_tokens) ||
    ((usage && usage.prompt_tokens) || 0) +
      ((usage && usage.completion_tokens) || 0);
  return Math.round((total / 1000) * STUB_USD_PER_1K * 1e6) / 1e6;
}

/**
 * @param {{
 *   provider?: { name?: string, complete: Function },
 *   circuitBreaker?: ReturnType<typeof createCircuitBreaker>,
 *   usageLog?: ReturnType<typeof createUsageLog>,
 *   limits?: object,
 *   now?: () => number,
 * }} [deps]
 */
function createLlmGateway(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const provider = d.provider || createStubProvider();
  const breaker = d.circuitBreaker || createCircuitBreaker({ now: d.now });
  const usageLog = d.usageLog || createUsageLog();
  const limits = normalizeLimits(d.limits);
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const bucket = createTenantBucket(limits, now);

  /**
   * @param {{ tenant_id?: string, body?: object }} req
   * @returns {Promise<{ status: number, body: object }>}
   */
  async function handleChatCompletions(req) {
    const r = req && typeof req === 'object' ? req : {};
    const tenantId = r.tenant_id;
    if (!tenantId || typeof tenantId !== 'string') {
      return { status: 400, body: { error: 'tenant_id_required' } };
    }
    const body = r.body && typeof r.body === 'object' ? r.body : {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return { status: 400, body: { error: 'messages_required' } };
    }
    if (!body.model || typeof body.model !== 'string') {
      return { status: 400, body: { error: 'model_required' } };
    }

    const admit = bucket.tryAcquire(tenantId);
    if (!admit.ok) {
      return {
        status: 429,
        body: { error: admit.error, retry_after_ms: 1000 },
      };
    }

    const providerName = provider.name || 'default';
    const gate = breaker.allow(providerName);
    if (!gate.allow) {
      return { status: 503, body: { error: 'circuit_open' } };
    }

    try {
      const completion = await provider.complete({
        model: body.model,
        messages: body.messages,
        stream: !!body.stream,
      });
      breaker.recordSuccess(providerName);
      const usage = completion.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      usageLog.record({
        tenant_id: tenantId,
        model: body.model,
        provider: providerName,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cost_usd: estimateCostUsd(usage),
        at_ms: now(),
      });
      return { status: 200, body: completion };
    } catch (e) {
      breaker.recordFailure(providerName);
      const code = (e && e.code) || 'provider_error';
      return {
        status: 502,
        body: { error: code, message: e && e.message ? String(e.message) : 'provider_error' },
      };
    }
  }

  return {
    handleChatCompletions,
    limits,
    usageLog,
  };
}

module.exports = {
  DEFAULT_LLM_LIMITS,
  createStubProvider,
  createUsageLog,
  createCircuitBreaker,
  createLlmGateway,
  estimateCostUsd,
};
