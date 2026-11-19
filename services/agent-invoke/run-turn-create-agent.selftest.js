'use strict';

const assert = require('assert');
const {
  createAgentRunTurn,
  assertFunctionLlmEgress,
} = require('./run-turn-create-agent');
const { createGatewayChatModel } = require('./llm-gateway-model');

async function main() {
  // Egress: provider host forbidden
  assert.throws(
    () => assertFunctionLlmEgress('https://api.openai.com/v1'),
    /provider_direct_forbidden/,
  );
  assert.throws(
    () =>
      createGatewayChatModel({
        baseUrl: 'https://api.anthropic.com',
        tenantId: 't1',
      }),
    /provider_direct_forbidden/,
  );

  // Gateway host OK + transport injection
  const calls = [];
  const model = createGatewayChatModel({
    baseUrl: 'http://aura-llm-gateway.aura.svc.cluster.local:8080',
    tenantId: 'tenant-a',
    transport: async (req) => {
      calls.push(req);
      return {
        status: 200,
        body: {
          choices: [{ message: { content: 'hello-from-gw' } }],
        },
      };
    },
  });
  const inv = await model.invoke([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(inv.content, 'hello-from-gw');
  assert.strictEqual(calls[0].headers['x-aura-tenant-id'], 'tenant-a');

  // createAgent injectable path
  const frames = [];
  const fakeCreateAgent = () => ({
    async invoke() {
      return { content: 'agent-out' };
    },
  });
  const out = await createAgentRunTurn(
    {
      run_id: 'run-1',
      stream: true,
      publishStream: async (id, f) => {
        frames.push({ id, ...f });
      },
      input: { text: 'ping' },
      principal: { id: 'u', tenant_id: 't' },
      memoryText: '',
      createAgent: fakeCreateAgent,
    },
    { createAgent: fakeCreateAgent },
  );
  assert.strictEqual(out.text, 'agent-out');
  assert.ok(frames.some((f) => f.type === 'token'));

  // Stub loop when no createAgent / langchain
  const frames2 = [];
  const stubOut = await createAgentRunTurn({
    run_id: 'run-2',
    stream: true,
    publishStream: async (_id, f) => frames2.push(f),
    input: { text: 'x' },
    principal: { id: 'u', tenant_id: 't' },
    memoryText: 'mem',
    createAgent: null,
  });
  assert.ok(stubOut.text.includes('ack:'));
  assert.ok(frames2.some((f) => f.type === 'token'));

  console.log('OK: run-turn-create-agent.selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
