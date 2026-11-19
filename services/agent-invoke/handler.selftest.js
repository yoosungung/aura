'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createMemoryKv,
  createTenantRateLimiter,
} = require('../gateway/rate-limit');
const {
  validateInvokeTask,
  packRecallItems,
  estimateTokens,
  buildStreamSubject,
  invokeOnce,
} = require('./handler');

async function main() {
  const src = fs.readFileSync(path.join(__dirname, 'handler.js'), 'utf8');
  assert.ok(!/\brequire\(['"]pg['"]\)/.test(src), 'handler must not require pg directly');
  assert.ok(!/set_config/.test(src), 'handler must not call set_config (checkpoints.js owns it)');
  assert.ok(!/memory_items|memory_embeddings/.test(src), 'handler must not touch memory_*');

  // validate: identifiers only + principal.tenant_id required
  const ok = validateInvokeTask({
    run_id: '019a0000-0000-7000-8000-000000000001',
    agent: 'demo',
    version: '1.0.0',
    session_id: 'sess-1',
    stream: true,
    input: { text: 'hello' },
    principal: {
      id: 'user-1',
      tenant_id: '11111111-1111-1111-1111-111111111111',
    },
  });
  assert.strictEqual(ok.ok, true);

  assert.strictEqual(
    validateInvokeTask({
      agent: 'demo',
      version: '1.0.0',
      principal: { id: 'u', tenant_id: 't' },
    }).ok,
    false,
  );
  assert.strictEqual(
    validateInvokeTask({
      run_id: 'r1',
      agent: 'demo',
      version: '1.0.0',
      principal: { id: 'u' },
    }).ok,
    false,
  );

  assert.strictEqual(
    buildStreamSubject('019a0000-0000-7000-8000-000000000001'),
    'aura.stream.019a0000-0000-7000-8000-000000000001',
  );

  // packing: recall items[] only; slot budgets; no spill
  const packed = packRecallItems([
    { memory_type: 'short_term', content: 's1' },
    { memory_type: 'short_term', content: 's2' },
    { memory_type: 'short_term', content: 's3' },
    { memory_type: 'short_term', content: 's4' },
    { memory_type: 'short_term', content: 's5-drop' },
    { memory_type: 'episodic', content: 'e1' },
    { memory_type: 'long_term', content: 'l1' },
    { memory_type: 'semantic', content: 'sem1' },
  ]);
  assert.strictEqual(packed.short_term.length, 4);
  assert.ok(!packed.short_term.some((x) => x.content === 's5-drop'));
  assert.ok(packed.episodic.length >= 1);
  assert.ok(packed.long_term_semantic.length >= 1);
  assert.ok(estimateTokens('abcd') >= 1);

  const frames = [];
  const rpcCalls = { resolve: 0, recall: 0, mcp: 0 };

  const done = await invokeOnce(
    {
      run_id: '019a0000-0000-7000-8000-0000000000aa',
      agent: 'demo',
      version: '1.0.0',
      session_id: 'sess-9',
      stream: true,
      input: { text: 'ping', tool: { server: 'demo-mcp', name: 'echo', arguments: { x: 1 } } },
      principal: {
        id: 'user-1',
        tenant_id: '11111111-1111-1111-1111-111111111111',
      },
    },
    {
      resolve: async (req) => {
        rpcCalls.resolve += 1;
        assert.strictEqual(req.kind, 'agent');
        assert.strictEqual(req.name, 'demo');
        assert.strictEqual(req.version, '1.0.0');
        return {
          type: 'control.resolve.done',
          cfg: { tone: 'brief' },
          secrets_ref: 'k8s:secret/demo',
          source: { entrypoint: 'main:factory' },
        };
      },
      recall: async (req) => {
        rpcCalls.recall += 1;
        assert.strictEqual(req.tenant_id, '11111111-1111-1111-1111-111111111111');
        return {
          items: [
            { memory_type: 'short_term', content: 'prefer dark mode' },
            { memory_type: 'episodic', content: 'opened ticket yesterday' },
          ],
        };
      },
      mcpTool: async (req) => {
        rpcCalls.mcp += 1;
        assert.strictEqual(req.server, 'demo-mcp');
        assert.strictEqual(req.tool, 'echo');
        return { ok: true, result: { echoed: req.arguments } };
      },
      publishStream: async (runId, frame) => {
        frames.push({ runId, frame });
      },
    },
  );

  assert.strictEqual(done.type, 'agent.invoke.done');
  assert.strictEqual(done.tenant_id, '11111111-1111-1111-1111-111111111111');
  assert.strictEqual(done.payload.run_id, '019a0000-0000-7000-8000-0000000000aa');
  assert.strictEqual(done.payload.agent, 'demo');
  assert.strictEqual(done.payload.version, '1.0.0');
  assert.ok(done.payload.output && typeof done.payload.output.text === 'string');
  assert.strictEqual(rpcCalls.resolve, 1);
  assert.strictEqual(rpcCalls.recall, 1);
  assert.strictEqual(rpcCalls.mcp, 1);

  const types = frames.map((f) => f.frame.type);
  assert.deepStrictEqual(types.slice(0, 1), ['run.started']);
  assert.ok(types.includes('token'), 'must emit token before done');
  assert.ok(types.includes('tool.started'));
  assert.ok(types.includes('tool.finished'));
  assert.strictEqual(types[types.length - 1], 'run.completed');
  assert.ok(
    types.indexOf('token') < types.indexOf('run.completed'),
    'token before run.completed (V3.1)',
  );
  for (const f of frames) {
    assert.strictEqual(f.runId, '019a0000-0000-7000-8000-0000000000aa');
    assert.ok(
      ['run.started', 'token', 'tool.started', 'tool.finished', 'error', 'run.completed'].includes(
        f.frame.type,
      ),
    );
  }
  const started = frames[0].frame;
  assert.strictEqual(started.run_id, '019a0000-0000-7000-8000-0000000000aa');
  assert.strictEqual(started.session_id, 'sess-9');
  assert.strictEqual(started.agent, 'demo');
  assert.strictEqual(started.version, '1.0.0');

  // stream:false → no Core frames; still done event
  const batchFrames = [];
  const batch = await invokeOnce(
    {
      run_id: '019a0000-0000-7000-8000-0000000000bb',
      agent: 'batch',
      version: '0.1.0',
      stream: false,
      input: { text: 'batch' },
      principal: { id: 'u', tenant_id: 't1' },
    },
    {
      resolve: async () => ({ type: 'control.resolve.done', cfg: {}, secrets_ref: null }),
      recall: async () => ({ items: [] }),
      mcpTool: async () => {
        throw new Error('mcp_should_not_run');
      },
      publishStream: async (_runId, frame) => {
        batchFrames.push(frame);
      },
    },
  );
  assert.strictEqual(batch.type, 'agent.invoke.done');
  assert.strictEqual(batchFrames.length, 0);

  // plaintext secrets from resolve → reject (§1 #11)
  let secretsRejected = false;
  try {
    await invokeOnce(
      {
        run_id: '019a0000-0000-7000-8000-0000000000dd',
        agent: 'demo',
        version: '1.0.0',
        principal: { id: 'u', tenant_id: 't1' },
      },
      {
        resolve: async () => ({
          type: 'control.resolve.done',
          cfg: {},
          secrets_ref: null,
          secrets: { api_key: 'leak' },
        }),
        recall: async () => ({ items: [] }),
        publishStream: async () => {},
      },
    );
  } catch (err) {
    secretsRejected = err.message === 'secrets_plaintext_forbidden';
  }
  assert.ok(secretsRejected, 'must reject plaintext secrets from resolve');

  // identifiers-only: bundle dump rejected
  assert.strictEqual(
    validateInvokeTask({
      run_id: 'r',
      agent: 'a',
      version: '1',
      principal: { id: 'u', tenant_id: 't' },
      bundle: { uri: 's3://x' },
    }).ok,
    false,
  );

  // HTTP handler path
  const handler = require('./handler');
  const httpFrames = [];
  const res = await handler({
    request: {
      body: JSON.stringify({
        run_id: '019a0000-0000-7000-8000-0000000000cc',
        agent: 'demo',
        version: '1.0.0',
        stream: true,
        input: { text: 'hi' },
        principal: { id: 'u', tenant_id: 't2' },
      }),
    },
    resolve: async () => ({ type: 'control.resolve.done', cfg: {}, secrets_ref: null }),
    recall: async () => ({ items: [{ memory_type: 'short_term', content: 'ctx' }] }),
    publishStream: async (_r, frame) => {
      httpFrames.push(frame);
    },
  });
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.type, 'agent.invoke.done');
  assert.ok(httpFrames.some((f) => f.type === 'token'));
  assert.ok(httpFrames.some((f) => f.type === 'run.completed'));

  const bad = await handler({
    request: { body: JSON.stringify({ agent: 'x' }) },
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.parse(bad.body).type, 'agent.invoke.error');

  // --- §2.2 bypass reconfirm (동일 KV · 초과=poison 4xx) ---
  const kvQ = createMemoryKv();
  const limitsQ = { ratePerSec: 1, burst: 1, maxInflight: 1 };
  const tQ = 1_700_000_200_000;
  const rlQ = createTenantRateLimiter({
    kv: kvQ,
    limits: limitsQ,
    now: () => tQ,
  });
  const runGw = '019a0000-0000-7000-8000-00000000gw01';
  const runBypass = '019a0000-0000-7000-8000-00000000byp1';
  assert.ok((await rlQ.tryAcquire('tenant-q', runGw)).ok);

  // Gateway-admitted run_id: idempotent pass, turn runs
  const framesGw = [];
  const doneGw = await invokeOnce(
    {
      run_id: runGw,
      agent: 'demo',
      version: '1.0.0',
      stream: true,
      input: { text: 'via-gw' },
      principal: { id: 'u', tenant_id: 'tenant-q' },
    },
    {
      rateLimiter: rlQ,
      resolve: async () => ({ type: 'control.resolve.done', cfg: {}, secrets_ref: null }),
      recall: async () => ({ items: [] }),
      publishStream: async (_r, f) => {
        framesGw.push(f);
      },
    },
  );
  assert.strictEqual(doneGw.type, 'agent.invoke.done');
  assert.ok(framesGw.some((f) => f.type === 'token'));

  // Bypass with empty bucket → poison error, no turn tokens
  const framesBy = [];
  let bypassRejected = false;
  try {
    await invokeOnce(
      {
        run_id: runBypass,
        agent: 'demo',
        version: '1.0.0',
        stream: true,
        input: { text: 'bypass' },
        principal: { id: 'u', tenant_id: 'tenant-q' },
      },
      {
        rateLimiter: rlQ,
        resolve: async () => {
          throw new Error('must_not_resolve');
        },
        recall: async () => {
          throw new Error('must_not_recall');
        },
        publishStream: async (_r, f) => {
          framesBy.push(f);
        },
      },
    );
  } catch (err) {
    bypassRejected =
      err.poison === true &&
      (err.message === 'rate_limited' || err.message === 'max_inflight_exceeded') &&
      (err.status === 429 || err.status === 422);
  }
  assert.ok(bypassRejected, 'bypass over quota must poison without turn');
  assert.ok(
    framesBy.some((f) => f.type === 'error'),
    'bypass reject should emit stream error frame',
  );
  assert.ok(!framesBy.some((f) => f.type === 'token'));

  const httpPoison = await handler({
    request: {
      body: JSON.stringify({
        run_id: '019a0000-0000-7000-8000-00000000byp2',
        agent: 'demo',
        version: '1.0.0',
        principal: { id: 'u', tenant_id: 'tenant-q' },
      }),
    },
    rateLimiter: rlQ,
    resolve: async () => ({ type: 'control.resolve.done', cfg: {}, secrets_ref: null }),
    recall: async () => ({ items: [] }),
  });
  assert.ok(httpPoison.status >= 400 && httpPoison.status < 500);
  assert.strictEqual(JSON.parse(httpPoison.body).type, 'agent.invoke.error');
  assert.strictEqual(JSON.parse(httpPoison.body).poison, true);

  console.log('handler.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
