'use strict';

/**
 * Offline selftest — LLM Gateway 최소 (§9.4) + Function Egress는 Gateway만.
 */

const assert = require('assert');
const {
  createLlmGateway,
  createStubProvider,
  createCircuitBreaker,
  createUsageLog,
  DEFAULT_LLM_LIMITS,
} = require('./gateway');
const {
  assertFunctionLlmEgress,
  createLlmGatewayClient,
  GATEWAY_HOSTS,
  PROVIDER_BLOCKLIST,
} = require('./client');
const {
  PROVIDER_KINDS,
  providersFromConfig,
  loadProvidersFile,
  embeddingsFromConfig,
  loadEmbeddingsConfig,
  createEmbeddingsClient,
  routingFromConfig,
} = require('./providers');
const { scorePrompt, resolveRoute, AUTO_MODEL } = require('./router');
const { createServer } = require('./entrypoint');

const ROUTING_TIERS = Object.freeze({
  tiers: {
    simple: 'model-cheap',
    medium: 'model-mid',
    complex: 'model-strong',
  },
});

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

async function testEgressClientGuard() {
  for (const host of GATEWAY_HOSTS) {
    assert.doesNotThrow(() =>
      assertFunctionLlmEgress(`http://${host}:8080/v1/chat/completions`),
    );
  }
  for (const bad of [
    'https://api.openai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://generativelanguage.googleapis.com/v1',
  ]) {
    assert.throws(
      () => assertFunctionLlmEgress(bad),
      (e) => e && e.code === 'provider_direct_forbidden',
    );
  }
  for (const h of PROVIDER_BLOCKLIST) {
    assert.throws(
      () => assertFunctionLlmEgress(`https://${h}/v1`),
      (e) => e && e.code === 'provider_direct_forbidden',
    );
  }
  ok('function client egress: gateway allow / provider deny');
}

async function testChatHappyPath() {
  const usage = createUsageLog();
  const gw = createLlmGateway({
    provider: createStubProvider({ content: 'hello-from-stub' }),
    usageLog: usage,
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't1',
    body: {
      model: 'aura-default',
      messages: [{ role: 'user', content: 'ping' }],
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.object, 'chat.completion');
  assert.ok(res.body.choices[0].message.content.includes('hello-from-stub'));
  assert.ok(res.body.usage);
  assert.ok(res.body.usage.prompt_tokens >= 1);
  assert.ok(res.body.usage.completion_tokens >= 1);
  assert.strictEqual(usage.entries.length, 1);
  assert.strictEqual(usage.entries[0].tenant_id, 't1');
  assert.ok(usage.entries[0].cost_usd != null);
  ok('chat completions happy path + usage log');
}

async function testValidation() {
  const gw = createLlmGateway({ provider: createStubProvider() });
  const missingTenant = await gw.handleChatCompletions({
    body: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.strictEqual(missingTenant.status, 400);
  assert.strictEqual(missingTenant.body.error, 'tenant_id_required');

  const badMsg = await gw.handleChatCompletions({
    tenant_id: 't1',
    body: { model: 'm', messages: 'nope' },
  });
  assert.strictEqual(badMsg.status, 400);
  assert.strictEqual(badMsg.body.error, 'messages_required');
  ok('request validation');
}

async function testRateLimit() {
  const gw = createLlmGateway({
    provider: createStubProvider(),
    limits: { ratePerSec: 1, burst: 1 },
    now: (() => {
      let t = 1_000_000;
      return () => t;
    })(),
  });
  const a = await gw.handleChatCompletions({
    tenant_id: 'noisy',
    body: { model: 'm', messages: [{ role: 'user', content: 'a' }] },
  });
  assert.strictEqual(a.status, 200);
  const b = await gw.handleChatCompletions({
    tenant_id: 'noisy',
    body: { model: 'm', messages: [{ role: 'user', content: 'b' }] },
  });
  assert.strictEqual(b.status, 429);
  assert.strictEqual(b.body.error, 'rate_limited');

  const other = await gw.handleChatCompletions({
    tenant_id: 'quiet',
    body: { model: 'm', messages: [{ role: 'user', content: 'c' }] },
  });
  assert.strictEqual(other.status, 200);
  ok('tenant rate limit 429; other tenant unaffected');
}

async function testCircuitBreaker() {
  let failCount = 0;
  const flaky = {
    name: 'flaky',
    async complete() {
      failCount += 1;
      const err = new Error('upstream_down');
      err.code = 'provider_error';
      throw err;
    },
  };
  const breaker = createCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => 1_000_000,
  });
  const gw = createLlmGateway({
    provider: flaky,
    circuitBreaker: breaker,
    limits: { ratePerSec: 100, burst: 100 },
  });
  const r1 = await gw.handleChatCompletions({
    tenant_id: 'cb',
    body: { model: 'm', messages: [{ role: 'user', content: '1' }] },
  });
  assert.strictEqual(r1.status, 502);
  const r2 = await gw.handleChatCompletions({
    tenant_id: 'cb',
    body: { model: 'm', messages: [{ role: 'user', content: '2' }] },
  });
  assert.strictEqual(r2.status, 502);
  const r3 = await gw.handleChatCompletions({
    tenant_id: 'cb',
    body: { model: 'm', messages: [{ role: 'user', content: '3' }] },
  });
  assert.strictEqual(r3.status, 503);
  assert.strictEqual(r3.body.error, 'circuit_open');
  assert.strictEqual(failCount, 2, 'open circuit must not call provider');
  ok('circuit breaker opens after failures');
}

async function testClientRoundTrip() {
  const gw = createLlmGateway({
    provider: createStubProvider({ content: 'via-client' }),
  });
  const client = createLlmGatewayClient({
    baseUrl: 'http://aura-llm-gateway.aura.svc.cluster.local:8080',
    transport: async (req) => {
      assert.strictEqual(req.path, '/v1/chat/completions');
      return gw.handleChatCompletions({
        tenant_id: req.headers['x-aura-tenant-id'],
        body: req.body,
      });
    },
  });
  const out = await client.chatCompletions({
    tenant_id: 't-client',
    model: 'aura-default',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.status, 200);
  assert.ok(out.body.choices[0].message.content.includes('via-client'));

  assert.throws(
    () =>
      createLlmGatewayClient({
        baseUrl: 'https://api.openai.com',
      }),
    (e) => e && e.code === 'provider_direct_forbidden',
  );
  ok('function client round-trip + constructor guard');
}

async function testDefaultsExported() {
  assert.ok(DEFAULT_LLM_LIMITS.ratePerSec > 0);
  assert.ok(DEFAULT_LLM_LIMITS.burst >= 1);
  ok('default limits exported');
}

async function testFallbackOnPrimaryFailure() {
  const usage = createUsageLog();
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = {
    name: 'primary',
    async complete() {
      primaryCalls += 1;
      const err = new Error('primary_down');
      err.code = 'provider_error';
      throw err;
    },
  };
  const fallback = {
    name: 'fallback',
    async complete(req) {
      fallbackCalls += 1;
      return {
        id: 'chatcmpl-fb',
        object: 'chat.completion',
        created: 1,
        model: req.model || 'aura-fallback',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'from-fallback' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        provider: 'fallback',
      };
    },
  };
  const { createLlmGateway: createGw } = require('./gateway');
  const gw = createGw({
    providers: [primary, fallback],
    fallbackModels: { 'aura-default': 'aura-fallback' },
    usageLog: usage,
    limits: { ratePerSec: 100, burst: 100 },
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't-fb',
    body: {
      model: 'aura-default',
      messages: [{ role: 'user', content: 'hi' }],
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(primaryCalls, 1);
  assert.strictEqual(fallbackCalls, 1);
  assert.ok(res.body.choices[0].message.content.includes('from-fallback'));
  assert.ok(res.body.aura);
  assert.strictEqual(res.body.aura.fallback_used, true);
  assert.strictEqual(res.body.aura.provider, 'fallback');
  assert.strictEqual(res.body.aura.model_served, 'aura-fallback');
  assert.ok(Array.isArray(res.body.aura.attempts));
  assert.ok(res.body.aura.attempts.length >= 2);
  assert.strictEqual(usage.entries.length, 1);
  assert.strictEqual(usage.entries[0].fallback_used, true);
  assert.strictEqual(usage.entries[0].provider, 'fallback');
  ok('fallback model after primary failure');
}

async function testFallbackSkipsOpenCircuit() {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = {
    name: 'prim-open',
    async complete() {
      primaryCalls += 1;
      throw Object.assign(new Error('should_not'), { code: 'provider_error' });
    },
  };
  const fallback = {
    name: 'fb-ok',
    async complete(req) {
      fallbackCalls += 1;
      return {
        id: 'ok',
        object: 'chat.completion',
        created: 1,
        model: req.model || 'aura-fallback',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'circuit-skip' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const breaker = createCircuitBreaker({
    failureThreshold: 1,
    cooldownMs: 60_000,
    now: () => 1_000_000,
  });
  breaker.recordFailure('prim-open');
  const gw = createLlmGateway({
    providers: [primary, fallback],
    fallbackModels: { 'aura-default': 'aura-fallback' },
    circuitBreaker: breaker,
    limits: { ratePerSec: 100, burst: 100 },
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't-cb-fb',
    body: {
      model: 'aura-default',
      messages: [{ role: 'user', content: 'x' }],
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(primaryCalls, 0, 'open circuit must skip primary');
  assert.strictEqual(fallbackCalls, 1);
  assert.strictEqual(res.body.aura.fallback_used, true);
  ok('fallback skips open primary circuit');
}

async function testAllProvidersFail() {
  const a = {
    name: 'a',
    async complete() {
      throw Object.assign(new Error('a'), { code: 'provider_error' });
    },
  };
  const b = {
    name: 'b',
    async complete() {
      throw Object.assign(new Error('b'), { code: 'provider_error' });
    },
  };
  const gw = createLlmGateway({
    providers: [a, b],
    limits: { ratePerSec: 100, burst: 100 },
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't-all',
    body: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.body.error, 'all_providers_failed');
  assert.ok(Array.isArray(res.body.attempts));
  assert.strictEqual(res.body.attempts.length, 2);
  ok('all providers failed → 502 with attempts');
}

async function testBillingDashboardAggregate() {
  const usage = createUsageLog();
  const gw = createLlmGateway({
    provider: createStubProvider({ content: 'bill' }),
    usageLog: usage,
    limits: { ratePerSec: 100, burst: 100 },
    now: (() => {
      let t = 1_700_000_000_000;
      return () => t;
    })(),
  });
  await gw.handleChatCompletions({
    tenant_id: 'ten-a',
    body: { model: 'm', messages: [{ role: 'user', content: 'aa' }] },
  });
  await gw.handleChatCompletions({
    tenant_id: 'ten-a',
    body: { model: 'm', messages: [{ role: 'user', content: 'bb' }] },
  });
  await gw.handleChatCompletions({
    tenant_id: 'ten-b',
    body: { model: 'm', messages: [{ role: 'user', content: 'cc' }] },
  });

  const all = gw.handleBillingUsage({});
  assert.strictEqual(all.status, 200);
  assert.ok(Array.isArray(all.body.tenants));
  assert.strictEqual(all.body.tenants.length, 2);
  const a = all.body.tenants.find((t) => t.tenant_id === 'ten-a');
  const b = all.body.tenants.find((t) => t.tenant_id === 'ten-b');
  assert.strictEqual(a.request_count, 2);
  assert.strictEqual(b.request_count, 1);
  assert.ok(a.cost_usd > 0);
  assert.ok(a.total_tokens > 0);

  const one = gw.handleBillingUsage({ tenant_id: 'ten-b' });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.tenants.length, 1);
  assert.strictEqual(one.body.tenants[0].tenant_id, 'ten-b');

  const { renderBillingDashboard } = require('./gateway');
  const dash = renderBillingDashboard(all.body);
  assert.ok(typeof dash === 'string');
  assert.ok(dash.includes('ten-a'));
  assert.ok(dash.includes('cost_usd') || dash.includes('Cost'));
  ok('tenant billing usage aggregate + dashboard render');
}

async function testProviderKinds() {
  for (const kind of ['stub', 'ollama', 'openai', 'vllm', 'sglang']) {
    assert.ok(PROVIDER_KINDS[kind], kind);
  }
  assert.strictEqual(
    PROVIDER_KINDS.vllm.defaultBaseUrl,
    'http://vllm.aura.svc.cluster.local:8000/v1',
  );
  assert.strictEqual(
    PROVIDER_KINDS.sglang.defaultBaseUrl,
    'http://sglang.aura.svc.cluster.local:30000/v1',
  );
  assert.strictEqual(PROVIDER_KINDS.ollama.defaultModel, 'gemma4:e2b');

  assert.throws(
    () => providersFromConfig(JSON.stringify({ providers: [{ kind: 'tensorrt' }] })),
    (e) => e && e.code === 'provider_kind_invalid',
  );

  const calls = [];
  const providers = providersFromConfig(
    JSON.stringify({
      providers: [
        { name: 'local-vllm', kind: 'vllm', model: 'served-model' },
        {
          name: 'local-sglang',
          kind: 'sglang',
          apiKeyEnv: 'SGLANG_API_KEY',
        },
      ],
    }),
    {
      env: { SGLANG_API_KEY: 'sglang-secret' },
      fetch: async (url, init) => {
        calls.push({ url, init: JSON.parse(init.body), headers: init.headers });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        };
      },
    },
  );
  assert.strictEqual(providers[0].baseUrl, PROVIDER_KINDS.vllm.defaultBaseUrl);
  assert.strictEqual(providers[1].baseUrl, PROVIDER_KINDS.sglang.defaultBaseUrl);
  const pinned = await providers[0].complete({
    model: 'client-asked',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(calls[0].url, `${PROVIDER_KINDS.vllm.defaultBaseUrl}/chat/completions`);
  assert.strictEqual(calls[0].init.model, 'served-model');
  assert.strictEqual(pinned.provider, 'local-vllm');
  await providers[1].complete({
    model: 'client-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(calls[1].url, `${PROVIDER_KINDS.sglang.defaultBaseUrl}/chat/completions`);
  assert.strictEqual(calls[1].init.model, 'client-model');
  assert.strictEqual(calls[1].headers.authorization, 'Bearer sglang-secret');

  const ollama = providersFromConfig(
    JSON.stringify({ providers: [{ kind: 'ollama', name: 'ollama' }] }),
    { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  );
  assert.strictEqual(ollama[0].model, 'gemma4:e2b');
  assert.strictEqual(ollama[0].baseUrl, PROVIDER_KINDS.ollama.defaultBaseUrl);

  const missing = loadProvidersFile('/tmp/aura-llm-providers-missing.json');
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].name, 'stub');
  ok('provider kinds: stub ollama openai vllm sglang');
}

async function testEmbeddingsCatalog() {
  assert.strictEqual(
    loadEmbeddingsConfig('/tmp/aura-llm-providers-missing.json'),
    null,
  );
  assert.throws(
    () =>
      embeddingsFromConfig(
        JSON.stringify({
          providers: [{ kind: 'stub' }],
          embeddings: { kind: 'tensorrt', model: 'x' },
        }),
      ),
    (e) => e && e.code === 'provider_kind_invalid',
  );
  assert.strictEqual(
    embeddingsFromConfig(JSON.stringify({ providers: [{ kind: 'stub' }] })),
    null,
  );

  const calls = [];
  const emb = embeddingsFromConfig(
    JSON.stringify({
      providers: [{ kind: 'stub' }],
      embeddings: {
        name: 'ollama-embed',
        kind: 'ollama',
        model: 'embeddinggemma-2:270m-mxfp8-text',
        baseUrl: 'http://host.orb.internal:11434/v1',
      },
    }),
    {
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: Array(768).fill(0.1) }],
            model: 'embeddinggemma-2:270m-mxfp8-text',
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
        };
      },
    },
  );
  assert.strictEqual(emb.model, 'embeddinggemma-2:270m-mxfp8-text');
  const out = await emb.embed({ input: 'hello' });
  assert.strictEqual(calls[0].url, 'http://host.orb.internal:11434/v1/embeddings');
  assert.strictEqual(calls[0].body.model, 'embeddinggemma-2:270m-mxfp8-text');
  assert.strictEqual(calls[0].body.input, 'hello');
  assert.strictEqual(out.data[0].embedding.length, 768);
  assert.strictEqual(out.provider, 'ollama-embed');
  ok('embeddings catalog + OpenAI /embeddings proxy');
}

async function testRouterHeuristicUnits() {
  const simple = scorePrompt([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(simple.tier, 'simple');

  const complex = scorePrompt([
    {
      role: 'user',
      content:
        'Please analyze and design a step-by-step refactor plan for this ```js\nfunction x(){}\n``` and prove the complexity.',
    },
  ]);
  assert.strictEqual(complex.tier, 'complex');

  const pinned = resolveRoute({
    model: AUTO_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    pin: 'complex',
    routingConfig: ROUTING_TIERS,
  });
  assert.strictEqual(pinned.route.tier, 'complex');
  assert.strictEqual(pinned.model, 'model-strong');
  assert.strictEqual(pinned.route.pin, 'complex');

  const fixed = resolveRoute({
    model: 'aura-default',
    messages: [{ role: 'user', content: 'hi' }],
    routingConfig: ROUTING_TIERS,
  });
  assert.strictEqual(fixed.routed, false);
  assert.strictEqual(fixed.model, 'aura-default');
  ok('router heuristic units + pin never downgrade');
}

async function testAuraAutoRoutesSimpleAndComplex() {
  const served = [];
  const provider = {
    name: 'stub-route',
    async complete(req) {
      served.push(req.model);
      return {
        id: 'chatcmpl-route',
        object: 'chat.completion',
        created: 1,
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const usage = createUsageLog();
  const gw = createLlmGateway({
    provider,
    routing: ROUTING_TIERS,
    usageLog: usage,
    limits: { ratePerSec: 100, burst: 100 },
  });

  const hi = await gw.handleChatCompletions({
    tenant_id: 't-route',
    body: { model: 'aura-auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(hi.status, 200);
  assert.strictEqual(hi.body.aura.route.tier, 'simple');
  assert.strictEqual(hi.body.aura.route.model_selected, 'model-cheap');
  assert.strictEqual(hi.body.aura.model_requested, 'aura-auto');
  assert.strictEqual(hi.body.aura.model_served, 'model-cheap');
  assert.strictEqual(served[0], 'model-cheap');
  assert.strictEqual(usage.entries[0].route_tier, 'simple');

  const hard = await gw.handleChatCompletions({
    tenant_id: 't-route',
    body: {
      model: 'aura-auto',
      messages: [
        {
          role: 'user',
          content:
            'Analyze and design a step-by-step architecture; include ```python\ndef f():\n  pass\n``` and prove the theorem.',
        },
      ],
    },
  });
  assert.strictEqual(hard.status, 200);
  assert.strictEqual(hard.body.aura.route.tier, 'complex');
  assert.strictEqual(hard.body.aura.model_served, 'model-strong');
  assert.strictEqual(served[1], 'model-strong');
  ok('aura-auto routes simple→cheap and complex→strong');
}

async function testPinnedModelSkipsRouter() {
  const served = [];
  const gw = createLlmGateway({
    provider: {
      name: 'stub',
      async complete(req) {
        served.push(req.model);
        return {
          id: 'c',
          object: 'chat.completion',
          created: 1,
          model: req.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    },
    routing: ROUTING_TIERS,
    limits: { ratePerSec: 100, burst: 100 },
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't-pin-model',
    body: { model: 'aura-default', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.aura.route, undefined);
  assert.strictEqual(served[0], 'aura-default');
  ok('concrete model skips content router');
}

async function testRoutePinNeverDowngrades() {
  const gw = createLlmGateway({
    provider: createStubProvider({ content: 'p' }),
    routing: ROUTING_TIERS,
    limits: { ratePerSec: 100, burst: 100 },
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't-pin',
    route_pin: 'complex',
    body: { model: 'aura-auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.aura.route.tier, 'complex');
  assert.strictEqual(res.body.aura.route.pin, 'complex');
  assert.strictEqual(res.body.aura.model_served, 'model-strong');
  ok('route pin never downgrades tier');
}

async function testRouteThenFallback() {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const gw = createLlmGateway({
    providers: [
      {
        name: 'primary',
        async complete() {
          primaryCalls += 1;
          const err = new Error('boom');
          err.code = 'provider_error';
          throw err;
        },
      },
      {
        name: 'secondary',
        async complete(req) {
          fallbackCalls += 1;
          return {
            id: 'c',
            object: 'chat.completion',
            created: 1,
            model: req.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'fb' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    ],
    routing: ROUTING_TIERS,
    fallbackModels: { 'model-cheap': 'model-cheap-fb' },
    limits: { ratePerSec: 100, burst: 100 },
  });
  const res = await gw.handleChatCompletions({
    tenant_id: 't-rfb',
    body: { model: 'aura-auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.aura.route.tier, 'simple');
  assert.strictEqual(res.body.aura.fallback_used, true);
  assert.strictEqual(res.body.aura.model_served, 'model-cheap-fb');
  assert.strictEqual(primaryCalls, 1);
  assert.strictEqual(fallbackCalls, 1);
  ok('content route then availability fallback');
}

async function testRoutingFromConfig() {
  const r = routingFromConfig(
    JSON.stringify({
      providers: [{ kind: 'stub' }],
      routing: { tiers: { simple: 'a', medium: 'b', complex: 'c' } },
    }),
  );
  assert.deepStrictEqual(r.tiers, { simple: 'a', medium: 'b', complex: 'c' });
  assert.strictEqual(
    routingFromConfig(JSON.stringify({ providers: [{ kind: 'stub' }] })),
    null,
  );
  ok('routingFromConfig parses tiers');
}

async function testEmbeddingsHttp() {
  const vec = Array(4).fill(0.25);
  let fetchCalls = 0;
  const server = createServer({
    providersFile: null,
    provider: createStubProvider(),
    embeddings: createEmbeddingsClient(
      {
        name: 'ollama-embed',
        kind: 'ollama',
        model: 'embeddinggemma-2:270m-mxfp8-text',
        baseUrl: 'http://host.orb.internal:11434/v1',
      },
      {
        fetch: async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              object: 'list',
              data: [{ object: 'embedding', index: 0, embedding: vec }],
              model: 'embeddinggemma-2:270m-mxfp8-text',
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          };
        },
      },
    ),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const missingCfg = createServer({
      provider: createStubProvider(),
      embeddings: null,
    });
    await new Promise((resolve) => missingCfg.listen(0, '127.0.0.1', resolve));
    const p2 = missingCfg.address().port;
    const noCfg = await fetch(`http://127.0.0.1:${p2}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x' }),
    });
    assert.strictEqual(noCfg.status, 503);
    const noBody = await noCfg.json();
    assert.strictEqual(noBody.error, 'embeddings_not_configured');
    missingCfg.close();

    const bad = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(bad.status, 400);

    const okRes = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aura-tenant-id': 'ten-embed',
      },
      body: JSON.stringify({ input: 'hello lab' }),
    });
    assert.strictEqual(okRes.status, 200);
    const body = await okRes.json();
    assert.strictEqual(fetchCalls, 1);
    assert.strictEqual(body.data[0].embedding.length, 4);
    assert.strictEqual(body.model, 'embeddinggemma-2:270m-mxfp8-text');
    assert.strictEqual(body.aura.provider, 'ollama-embed');
  } finally {
    server.close();
  }
  ok('POST /v1/embeddings HTTP path');
}

(async () => {
  try {
    await testEgressClientGuard();
    await testChatHappyPath();
    await testValidation();
    await testRateLimit();
    await testCircuitBreaker();
    await testClientRoundTrip();
    await testDefaultsExported();
    await testFallbackOnPrimaryFailure();
    await testFallbackSkipsOpenCircuit();
    await testAllProvidersFail();
    await testBillingDashboardAggregate();
    await testProviderKinds();
    await testEmbeddingsCatalog();
    await testEmbeddingsHttp();
    await testRouterHeuristicUnits();
    await testAuraAutoRoutesSimpleAndComplex();
    await testPinnedModelSkipsRouter();
    await testRoutePinNeverDowngrades();
    await testRouteThenFallback();
    await testRoutingFromConfig();
    console.log('llm-gateway.selftest: PASS');
  } catch (e) {
    fail(e && e.stack ? e.stack : String(e));
  }
})();
