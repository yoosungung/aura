'use strict';

/**
 * Cluster LLM Gateway — sole Function→provider exit (ARCHITECTURE §9.4).
 * M3: chat completions · tenant rate limit · circuit breaker · usage/cost log.
 * M5: ordered Fallback 모델 · 테넌트 과금 대시보드(usage aggregate).
 * Non-goals: live provider 키 필수 CI · 가중치 서빙 · streaming SSE 본배선 · PG ledger.
 */

const DEFAULT_LLM_LIMITS = Object.freeze({
  ratePerSec: 20,
  burst: 40,
});

/** Rough USD/1k tokens for stub cost logging (not external invoice SoR). */
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
 * Resolve ordered providers. `provider` kept for M3 callers.
 * @param {object} d
 * @returns {object[]}
 */
function resolveProviders(d) {
  if (Array.isArray(d.providers) && d.providers.length > 0) {
    return d.providers;
  }
  return [d.provider || createStubProvider()];
}

/**
 * Map requested model → model id for a given attempt index.
 * @param {string} requested
 * @param {number} index
 * @param {Record<string, string>} [fallbackModels]
 */
function modelForAttempt(requested, index, fallbackModels) {
  if (index === 0) return requested;
  const map = fallbackModels && typeof fallbackModels === 'object' ? fallbackModels : {};
  if (map[requested]) return map[requested];
  return requested;
}

/**
 * Aggregate usage log into per-tenant billing rows.
 * @param {object[]} entries
 * @param {{ tenant_id?: string, from_ms?: number, to_ms?: number }} [filter]
 */
function aggregateBillingUsage(entries, filter) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const rows = Array.isArray(entries) ? entries : [];
  /** @type {Map<string, { tenant_id: string, request_count: number, prompt_tokens: number, completion_tokens: number, total_tokens: number, cost_usd: number }>} */
  const byTenant = new Map();
  for (const e of rows) {
    if (!e || typeof e !== 'object') continue;
    if (f.tenant_id && e.tenant_id !== f.tenant_id) continue;
    if (f.from_ms != null && Number(e.at_ms) < Number(f.from_ms)) continue;
    if (f.to_ms != null && Number(e.at_ms) > Number(f.to_ms)) continue;
    const tid = e.tenant_id || 'unknown';
    let acc = byTenant.get(tid);
    if (!acc) {
      acc = {
        tenant_id: tid,
        request_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
      };
      byTenant.set(tid, acc);
    }
    acc.request_count += 1;
    acc.prompt_tokens += Number(e.prompt_tokens) || 0;
    acc.completion_tokens += Number(e.completion_tokens) || 0;
    acc.total_tokens += Number(e.total_tokens) || 0;
    acc.cost_usd =
      Math.round((acc.cost_usd + (Number(e.cost_usd) || 0)) * 1e6) / 1e6;
  }
  const tenants = [...byTenant.values()].sort((a, b) =>
    a.tenant_id.localeCompare(b.tenant_id),
  );
  return {
    tenants,
    window: {
      from_ms: f.from_ms != null ? Number(f.from_ms) : null,
      to_ms: f.to_ms != null ? Number(f.to_ms) : null,
      tenant_id: f.tenant_id || null,
    },
  };
}

/**
 * Ops-facing plain-text dashboard (not a SPA).
 * @param {{ tenants?: object[] }} summary
 */
function renderBillingDashboard(summary) {
  const tenants = (summary && summary.tenants) || [];
  const lines = [
    '# Aura LLM Gateway — tenant billing dashboard',
    '',
    '| tenant_id | request_count | total_tokens | cost_usd |',
    '|---|---:|---:|---:|',
  ];
  for (const t of tenants) {
    lines.push(
      `| ${t.tenant_id} | ${t.request_count} | ${t.total_tokens} | ${t.cost_usd} |`,
    );
  }
  if (tenants.length === 0) {
    lines.push('| (none) | 0 | 0 | 0 |');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * @param {{
 *   provider?: { name?: string, complete: Function },
 *   providers?: { name?: string, complete: Function }[],
 *   fallbackModels?: Record<string, string>,
 *   circuitBreaker?: ReturnType<typeof createCircuitBreaker>,
 *   usageLog?: ReturnType<typeof createUsageLog>,
 *   limits?: object,
 *   now?: () => number,
 * }} [deps]
 */
function createLlmGateway(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const providers = resolveProviders(d);
  const fallbackModels =
    d.fallbackModels && typeof d.fallbackModels === 'object'
      ? d.fallbackModels
      : {};
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

    /** @type {{ provider: string, model: string, ok: boolean, error?: string }[]} */
    const attempts = [];
    let lastError = null;

    for (let i = 0; i < providers.length; i += 1) {
      const provider = providers[i];
      const providerName = provider.name || `provider-${i}`;
      const model = modelForAttempt(body.model, i, fallbackModels);
      const gate = breaker.allow(providerName);
      if (!gate.allow) {
        attempts.push({
          provider: providerName,
          model,
          ok: false,
          error: 'circuit_open',
        });
        lastError = { code: 'circuit_open' };
        continue;
      }

      try {
        const completion = await provider.complete({
          model,
          messages: body.messages,
          stream: !!body.stream,
        });
        breaker.recordSuccess(providerName);
        attempts.push({ provider: providerName, model, ok: true });
        const usage = completion.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
        const fallbackUsed = i > 0;
        usageLog.record({
          tenant_id: tenantId,
          model: body.model,
          model_served: model,
          provider: providerName,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          cost_usd: estimateCostUsd(usage),
          fallback_used: fallbackUsed,
          at_ms: now(),
        });
        const out = {
          ...completion,
          model,
          aura: {
            provider: providerName,
            model_requested: body.model,
            model_served: model,
            fallback_used: fallbackUsed,
            attempts,
          },
        };
        return { status: 200, body: out };
      } catch (e) {
        breaker.recordFailure(providerName);
        const code = (e && e.code) || 'provider_error';
        attempts.push({
          provider: providerName,
          model,
          ok: false,
          error: code,
        });
        lastError = e;
      }
    }

    if (attempts.length === 1 && attempts[0].error === 'circuit_open') {
      return { status: 503, body: { error: 'circuit_open', attempts } };
    }
    return {
      status: 502,
      body: {
        error: 'all_providers_failed',
        message:
          lastError && lastError.message
            ? String(lastError.message)
            : 'all_providers_failed',
        attempts,
      },
    };
  }

  /**
   * Tenant billing usage aggregate (과금 대시보드 API).
   * @param {{ tenant_id?: string, from_ms?: number, to_ms?: number }} [filter]
   */
  function handleBillingUsage(filter) {
    const body = aggregateBillingUsage(usageLog.entries, filter || {});
    return { status: 200, body };
  }

  return {
    handleChatCompletions,
    handleBillingUsage,
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
  aggregateBillingUsage,
  renderBillingDashboard,
};
