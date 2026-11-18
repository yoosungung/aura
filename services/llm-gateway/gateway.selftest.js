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

(async () => {
  try {
    await testEgressClientGuard();
    await testChatHappyPath();
    await testValidation();
    await testRateLimit();
    await testCircuitBreaker();
    await testClientRoundTrip();
    await testDefaultsExported();
    console.log('llm-gateway.selftest: PASS');
  } catch (e) {
    fail(e && e.stack ? e.stack : String(e));
  }
})();
