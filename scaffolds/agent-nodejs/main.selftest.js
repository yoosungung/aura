'use strict';

const assert = require('assert');
const { factory } = require('./main');
const { DEFAULT_TOOLS } = require('./lib/tools');

async function main() {
  const calls = [];
  const mcpTool = async (req) => {
    calls.push(req);
    return { ok: true, echo: req };
  };

  const agent = factory(
    { system_prompt: 'test-agent', _mcp_tool: mcpTool },
    'vault:ref',
  );
  assert.strictEqual(typeof agent.runTurn, 'function');

  const plain = await agent.runTurn({ message: 'hi' });
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.tag, 'scaffold-agent');
  assert.strictEqual(plain.text, 'ack:hi');
  assert.strictEqual(plain.system, 'test-agent');
  assert.strictEqual(plain.secrets_ref, 'vault:ref');
  assert.strictEqual(plain.tools.length, 2);
  assert.deepStrictEqual(
    plain.tools.map((t) => t.name),
    DEFAULT_TOOLS.map((t) => t.name),
  );

  const naver = await agent.runTurn({
    input: {
      text: 'search',
      tool: { name: 'naver_search', arguments: { query: 'aura' } },
    },
    mcpTool,
    secrets_ref: 'vault:ref',
  });
  assert.strictEqual(naver.ok, true);
  assert.strictEqual(naver.toolResult.ok, true);
  assert.strictEqual(calls[0].server, 'naver-search');
  assert.strictEqual(calls[0].tool, 'naver_search');
  assert.deepStrictEqual(calls[0].arguments, { query: 'aura' });

  const wx = await agent.runTurn({
    text: 'forecast',
    tool: {
      name: 'weather',
      arguments: { latitude: 37.57, longitude: 126.98 },
    },
  });
  assert.strictEqual(wx.ok, true);
  assert.strictEqual(calls[1].server, 'weather');
  assert.strictEqual(calls[1].tool, 'weather');

  const denied = await agent.runTurn({
    tool: { name: 'not_a_tool', arguments: {} },
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.error, 'tool_not_allowed');

  const noMcp = await factory({ system_prompt: 'x' }, null).runTurn({
    tool: { name: 'weather', arguments: {} },
  });
  assert.strictEqual(noMcp.ok, false);
  assert.strictEqual(noMcp.error, 'mcp_tool_required');

  console.log('agent-nodejs scaffold selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
