'use strict';

/**
 * Offline selftest — Function LLM egress client only.
 * Server (rate/circuit/fallback/aura-auto) = cargo test -p aura-llm-gateway.
 */

const assert = require('assert');
const {
  assertFunctionLlmEgress,
  createLlmGatewayClient,
  GATEWAY_HOSTS,
  PROVIDER_BLOCKLIST,
} = require('./client');

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

async function testClientRejectsProviderBaseUrl() {
  assert.throws(
    () =>
      createLlmGatewayClient({
        baseUrl: 'https://api.openai.com/v1',
        tenant_id: 't1',
      }),
    (e) => e && e.code === 'provider_direct_forbidden',
  );
  const client = createLlmGatewayClient({
    baseUrl: 'http://aura-llm-gateway.aura.svc.cluster.local:8080',
    transport: async () => ({ status: 200, body: { ok: true } }),
  });
  const res = await client.chatCompletions({
    tenant_id: 't1',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(res.status, 200);
  ok('createLlmGatewayClient allowlist + transport');
}

async function main() {
  await testEgressClientGuard();
  await testClientRejectsProviderBaseUrl();
  console.log('gateway.selftest: PASS (client egress)');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
