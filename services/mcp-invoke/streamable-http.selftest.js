'use strict';

const assert = require('assert');
const {
  DEFAULT_PROTOCOL_VERSION,
  buildToolsCallRequest,
  parseJsonOrSseResponse,
  callToolViaStreamableHttp,
} = require('./streamable-http');

async function main() {
  assert.strictEqual(DEFAULT_PROTOCOL_VERSION, '2025-06-18');

  const built = buildToolsCallRequest({
    tool: 'echo',
    arguments: { x: 1 },
    id: 'req-1',
  });
  assert.strictEqual(built.id, 'req-1');
  assert.strictEqual(built.body.method, 'tools/call');
  assert.strictEqual(built.body.params.name, 'echo');
  assert.deepStrictEqual(built.body.params.arguments, { x: 1 });
  assert.throws(() => buildToolsCallRequest({}), /tool_required/);

  const jsonOk = parseJsonOrSseResponse({
    bodyText: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { content: [{ type: 'text', text: 'hi' }] },
    }),
    contentType: 'application/json',
    wantId: 'req-1',
  });
  assert.strictEqual(jsonOk.ok, true);
  assert.strictEqual(jsonOk.message.result.content[0].text, 'hi');

  const sseOk = parseJsonOrSseResponse({
    bodyText: [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      '',
      'data: {"jsonrpc":"2.0","id":"req-1","result":{"content":[{"type":"text","text":"sse"}]}}',
      '',
    ].join('\n'),
    contentType: 'text/event-stream',
    wantId: 'req-1',
  });
  assert.strictEqual(sseOk.ok, true);
  assert.strictEqual(sseOk.message.result.content[0].text, 'sse');

  assert.strictEqual(
    parseJsonOrSseResponse({ bodyText: '', contentType: 'application/json' }).ok,
    false,
  );

  const fetchJson = async (url, init) => {
    assert.strictEqual(url, 'https://mcp.example/mcp');
    assert.strictEqual(init.method, 'POST');
    assert.ok(String(init.headers.Accept).includes('application/json'));
    assert.ok(String(init.headers.Accept).includes('text/event-stream'));
    assert.strictEqual(init.headers['MCP-Protocol-Version'], '2025-06-18');
    assert.strictEqual(init.headers['Mcp-Session-Id'], 'sess-9');
    const body = JSON.parse(init.body);
    assert.strictEqual(body.method, 'tools/call');
    return {
      headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'pong' }] },
        }),
    };
  };

  const out = await callToolViaStreamableHttp({
    endpoint: 'https://mcp.example/mcp',
    tool: 'echo',
    arguments: { a: 1 },
    sessionId: 'sess-9',
    fetchImpl: fetchJson,
    id: 'fixed-id',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result.content[0].text, 'pong');

  const fetchSse = async (_url, init) => {
    const body = JSON.parse(init.body);
    return {
      headers: { 'content-type': 'text/event-stream' },
      text: async () =>
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'from-sse' }] },
        })}\n\n`,
    };
  };
  const sseOut = await callToolViaStreamableHttp({
    endpoint: 'http://127.0.0.1:9/mcp',
    tool: 't',
    fetchImpl: fetchSse,
  });
  assert.strictEqual(sseOut.ok, true);
  assert.strictEqual(sseOut.result.content[0].text, 'from-sse');

  const missing = await callToolViaStreamableHttp({
    tool: 't',
    fetchImpl: fetchJson,
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, 'endpoint_required');

  console.log('mcp-invoke streamable-http.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
