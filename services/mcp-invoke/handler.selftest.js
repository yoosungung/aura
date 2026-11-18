'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  validateMcpRequest,
  invokeToolOnce,
  handleTask,
  handleRpc,
} = require('./handler');

async function main() {
  const src = fs.readFileSync(path.join(__dirname, 'handler.js'), 'utf8');
  assert.ok(!/\brequire\(['"]pg['"]\)/.test(src), 'handler must not require pg');
  assert.ok(!/set_config/.test(src), 'handler must not call set_config');
  assert.ok(!/AURA_DATABASE_HOST/.test(src), 'handler must not reference AURA_DATABASE_HOST');
  assert.ok(!/\.query\s*\(/.test(src), 'handler must not call .query(');
  assert.ok(
    src.includes('aura.rpc.mcp.tool') || src.includes('mcp.tool'),
    'handler must mention mcp.tool contract',
  );
  assert.ok(src.includes('mcp.invoke.done'), 'handler must emit mcp.invoke.done');
  assert.ok(src.includes('mcp.tool.done'), 'handler must emit mcp.tool.done');
  assert.ok(
    src.includes('streamable_http') || src.includes('callToolViaStreamableHttp'),
    'handler must wire streamable HTTP adapter',
  );

  const base = {
    server: 'demo-mcp',
    version: '1.0.0',
    tool: 'echo',
    arguments: { x: 1 },
    principal: {
      id: 'user-1',
      tenant_id: '11111111-1111-1111-1111-111111111111',
    },
  };

  assert.strictEqual(validateMcpRequest(base).ok, true);
  assert.strictEqual(validateMcpRequest({ ...base, server: '' }).ok, false);
  assert.strictEqual(validateMcpRequest({ ...base, tool: null }).ok, false);
  assert.strictEqual(
    validateMcpRequest({ ...base, principal: { id: 'u' } }).ok,
    false,
  );
  assert.strictEqual(
    validateMcpRequest({ ...base, bundle: {} }).ok,
    false,
    'identifiers only — reject bundle',
  );
  assert.strictEqual(
    validateMcpRequest({ ...base, secrets: { k: 'v' } }).ok,
    false,
    'identifiers only — reject secrets',
  );
  assert.strictEqual(
    validateMcpRequest({ ...base, cfg: {} }).ok,
    false,
    'identifiers only — reject cfg',
  );

  let resolveCalls = 0;
  const deps = {
    resolve: async (req) => {
      resolveCalls += 1;
      assert.strictEqual(req.kind, 'mcp');
      assert.strictEqual(req.name, 'demo-mcp');
      assert.strictEqual(req.version, '1.0.0');
      assert.strictEqual(req.tenant_id, base.principal.tenant_id);
      return {
        type: 'control.resolve.done',
        cfg: { mode: 'stub' },
        secrets_ref: 'secret://demo',
        source: { name: req.name, version: req.version },
      };
    },
    runTool: async (ctx) => {
      assert.strictEqual(ctx.tool, 'echo');
      assert.deepStrictEqual(ctx.arguments, { x: 1 });
      assert.ok(ctx.cfg && ctx.cfg.mode === 'stub');
      assert.strictEqual(ctx.secrets_ref, 'secret://demo');
      return { echo: ctx.arguments, ok: true };
    },
  };

  const toolOut = await invokeToolOnce(base, deps);
  assert.strictEqual(resolveCalls, 1);
  assert.strictEqual(toolOut.ok, true);
  assert.deepStrictEqual(toolOut.result.echo, { x: 1 });

  let httpFetchCalls = 0;
  const httpDeps = {
    resolve: async () => ({
      cfg: {
        transport: 'streamable_http',
        mcp_endpoint: 'https://mcp.test/v1',
        mcp_session_id: 'sid-1',
      },
      secrets_ref: null,
    }),
    fetchImpl: async (url, init) => {
      httpFetchCalls += 1;
      assert.strictEqual(url, 'https://mcp.test/v1');
      assert.strictEqual(init.method, 'POST');
      assert.strictEqual(init.headers['Mcp-Session-Id'], 'sid-1');
      const body = JSON.parse(init.body);
      assert.strictEqual(body.method, 'tools/call');
      return {
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [] },
          }),
      };
    },
  };
  const httpOut = await invokeToolOnce(base, httpDeps);
  assert.strictEqual(httpFetchCalls, 1);
  assert.strictEqual(httpOut.ok, true);
  assert.deepStrictEqual(httpOut.result.content, []);
  assert.strictEqual(httpOut.result.mode, 'streamable_http');

  // plaintext secrets from resolve must be rejected
  await assert.rejects(
    () =>
      invokeToolOnce(base, {
        resolve: async () => ({
          cfg: {},
          secrets: { api_key: 'plain' },
          secrets_ref: null,
        }),
      }),
    /secrets_plaintext_forbidden/,
  );

  // --- async task path ---
  const taskRes = await handleTask(
    { ...base, id: '019a0000-0000-7000-8000-0000000000m1' },
    deps,
  );
  assert.strictEqual(taskRes.status, 200);
  const taskBody = JSON.parse(taskRes.body);
  assert.strictEqual(taskBody.type, 'mcp.invoke.done');
  assert.strictEqual(taskBody.tenant_id, base.principal.tenant_id);
  assert.strictEqual(taskBody.id, '019a0000-0000-7000-8000-0000000000m1');
  assert.ok(taskBody.occurred_at);
  assert.strictEqual(taskBody.payload.server, 'demo-mcp');
  assert.strictEqual(taskBody.payload.tool, 'echo');
  assert.strictEqual(taskBody.payload.version, '1.0.0');
  assert.ok(taskBody.payload.result);
  assert.strictEqual(taskBody.content_ref, null);

  const badTask = await handleTask({ server: 'x' }, deps);
  assert.ok(badTask.status >= 400);
  const badTaskBody = JSON.parse(badTask.body);
  assert.strictEqual(badTaskBody.type, 'mcp.invoke.error');

  // --- sync RPC path ---
  const rpcRes = await handleRpc(base, deps);
  assert.strictEqual(rpcRes.status, 200);
  const rpcBody = JSON.parse(rpcRes.body);
  assert.strictEqual(rpcBody.type, 'mcp.tool.done');
  assert.strictEqual(rpcBody.ok, true);
  assert.strictEqual(rpcBody.server, 'demo-mcp');
  assert.strictEqual(rpcBody.tool, 'echo');
  assert.strictEqual(rpcBody.version, '1.0.0');
  assert.ok(rpcBody.result);

  const badRpc = await handleRpc({ tool: 'echo' }, deps);
  assert.ok(badRpc.status >= 400);
  const badRpcBody = JSON.parse(badRpc.body);
  assert.strictEqual(badRpcBody.type, 'mcp.tool.error');
  assert.strictEqual(badRpcBody.ok, false);

  // Fission HTTP entry (task) via module.exports default
  const handler = require('./handler');
  const httpTask = await handler({
    request: { body: JSON.stringify({ ...base, id: 'id-http-1' }) },
    resolve: deps.resolve,
    runTool: deps.runTool,
  });
  assert.strictEqual(httpTask.status, 200);
  assert.strictEqual(JSON.parse(httpTask.body).type, 'mcp.invoke.done');

  const httpRpc = await handler({
    request: {
      body: JSON.stringify(base),
      headers: { 'x-aura-rpc': 'aura.rpc.mcp.tool' },
    },
    resolve: deps.resolve,
    runTool: deps.runTool,
  });
  assert.strictEqual(httpRpc.status, 200);
  assert.strictEqual(JSON.parse(httpRpc.body).type, 'mcp.tool.done');

  console.log('mcp-invoke handler.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
