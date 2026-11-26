'use strict';

const assert = require('assert');
const { factory } = require('./main');

async function main() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          total: 1,
          start: 1,
          display: 1,
          items: [{ title: 'Aura <b>MCP</b>', link: 'https://example.com', description: 'demo' }],
        };
      },
    };
  };

  const mcp = factory(
    { service: 'news', display: 5, fetchImpl },
    { client_id: 'id-lab', client_secret: 'sec-lab' },
  );

  const listed = await mcp.listTools();
  assert.strictEqual(listed.ok, true);
  assert.ok(listed.tools.some((t) => t.name === 'naver_search'));
  const tool = listed.tools.find((t) => t.name === 'naver_search');
  assert.ok(tool.inputSchema && tool.inputSchema.properties.query);

  const ran = await mcp.runTool({
    tool: 'naver_search',
    input: { query: 'aura mcp', sort: 'date' },
  });
  assert.strictEqual(ran.ok, true);
  assert.strictEqual(ran.tag, 'scaffold-mcp');
  assert.strictEqual(ran.tool, 'naver_search');
  assert.strictEqual(ran.service, 'news');
  assert.strictEqual(ran.total, 1);
  assert.strictEqual(ran.items.length, 1);
  assert.strictEqual(ran.items[0].title, 'Aura MCP');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /openapi\.naver\.com\/v1\/search\/news\.json/);
  assert.match(calls[0].url, /query=aura/);
  assert.strictEqual(calls[0].init.headers['X-Naver-Client-Id'], 'id-lab');
  assert.strictEqual(calls[0].init.headers['X-Naver-Client-Secret'], 'sec-lab');

  const missing = await factory({ fetchImpl }, null).runTool({
    tool: 'naver_search',
    input: { query: 'x' },
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, 'secrets_unresolved');

  const badTool = await mcp.runTool({ tool: 'nope', input: {} });
  assert.strictEqual(badTool.ok, false);
  assert.strictEqual(badTool.error, 'unknown_tool');

  const noQuery = await mcp.runTool({ tool: 'naver_search', input: {} });
  assert.strictEqual(noQuery.ok, false);
  assert.strictEqual(noQuery.error, 'query_required');

  console.log('mcp-nodejs scaffold selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
