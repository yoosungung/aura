'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createAgentRunTurn,
  assertFunctionLlmEgress,
} = require('./run-turn-create-agent');
const { createGatewayChatModel } = require('./llm-gateway-model');

function baseCtx(extra) {
  return {
    run_id: 'run-spec',
    stream: false,
    input: { text: 'ping' },
    principal: { id: 'u', tenant_id: 't' },
    memoryText: '',
    ...extra,
  };
}

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

  const specs = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../testdata/agent_specs.json'), 'utf8'),
  );

  // Two cfgs → different system prompt and tool allowlist.
  const seen = [];
  const recordingAgent = (args) => {
    seen.push(args);
    return {
      async invoke() {
        return { content: args.systemPrompt };
      },
    };
  };
  const supportOut = await createAgentRunTurn(
    baseCtx({ cfg: specs.support, agent: 'support' }),
    { createAgent: recordingAgent },
  );
  const researchOut = await createAgentRunTurn(
    baseCtx({ cfg: specs.researcher, agent: 'researcher' }),
    { createAgent: recordingAgent },
  );
  assert.ok(supportOut.text.startsWith('You are support.'));
  assert.ok(researchOut.text.startsWith('You are research.'));
  assert.deepStrictEqual(
    seen[0].tools.map((t) => t.name),
    ['search', 'subagent_researcher'],
  );
  assert.deepStrictEqual(seen[1].tools.map((t) => t.name), [
    'fetch',
    'subagent_support',
  ]);

  // Allowlist: outside tool is not called; listed tool is.
  const mcpCalls = [];
  const mcpTool = async (req) => {
    mcpCalls.push(req);
    return { ok: true, result: { tool: req.tool } };
  };
  await createAgentRunTurn(
    baseCtx({
      cfg: specs.support,
      agent: 'support',
      mcpTool,
      input: { text: 'x', tool: { name: 'fetch', server: 'web', version: '1.0.0' } },
    }),
    { createAgent: recordingAgent },
  );
  assert.strictEqual(mcpCalls.length, 0);
  await createAgentRunTurn(
    baseCtx({
      cfg: specs.support,
      agent: 'support',
      mcpTool,
      input: { text: 'x', tool: { name: 'search', server: 'docs', version: '1.0.0' } },
    }),
    { createAgent: recordingAgent },
  );
  assert.strictEqual(mcpCalls.length, 1);
  assert.strictEqual(mcpCalls[0].tool, 'search');
  assert.strictEqual(mcpCalls[0].server, 'docs');

  // Sub-agent re-enters createAgent after resolve. Child does not bind its sub_agents.
  const nested = [];
  const resolves = [];
  const nestedAgent = (args) => {
    nested.push(args);
    return {
      async invoke() {
        if (nested.length === 1) {
          const sub = args.tools.find((t) => t.name === 'subagent_researcher');
          return sub.invoke({ text: 'look up' });
        }
        return { content: 'child-out' };
      },
    };
  };
  const nestedFrames = [];
  const nestedOut = await createAgentRunTurn(
    baseCtx({
      cfg: specs.support,
      agent: 'support',
      version: '1.0.0',
      stream: true,
      publishStream: async (_id, frame) => nestedFrames.push(frame),
      resolve: async (req) => {
        resolves.push(req);
        assert.strictEqual(req.kind, 'agent');
        assert.strictEqual(req.tenant_id, 't');
        return { type: 'control.resolve.done', cfg: specs.researcher };
      },
    }),
    { createAgent: nestedAgent },
  );
  assert.strictEqual(nestedOut.text, 'child-out');
  assert.strictEqual(resolves.length, 1);
  assert.strictEqual(resolves[0].name, 'researcher');
  assert.strictEqual(resolves[0].version, '1.0.0');
  assert.strictEqual(nested.length, 2);
  assert.ok(nested[1].systemPrompt.startsWith('You are research.'));
  assert.deepStrictEqual(
    nested[1].tools.map((t) => t.name),
    ['fetch'],
  );
  assert.ok(nestedFrames.some((f) => f.type === 'token' && f.agent === 'researcher'));

  // Depth 3 and cycle rejected.
  await assert.rejects(
    () =>
      createAgentRunTurn(
        baseCtx({ depth: 3, agent: 'leaf', version: '1.0.0', cfg: { tools: [] } }),
        { createAgent: recordingAgent },
      ),
    /agent_depth_exceeded/,
  );
  await assert.rejects(
    () =>
      createAgentRunTurn(
        baseCtx({
          agent: 'support',
          version: '1.0.0',
          agentStack: ['support@1.0.0'],
          cfg: {
            system_prompt: 'loop',
            tools: [],
            sub_agents: [{ name: 'support', version: '1.0.0', description: 'self' }],
          },
        }),
        { createAgent: recordingAgent },
      ),
    /agent_cycle/,
  );

  console.log('OK: run-turn-create-agent.selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
