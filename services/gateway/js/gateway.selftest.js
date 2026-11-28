'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  issueRunId,
  isUuidV7,
  buildStreamSubject,
  assertExactStreamSubject,
  validatePrincipal,
  createRunRegistry,
  submitAgentInvoke,
  openStreamBridge,
  formatSseFrame,
  authorizeWs,
  handleSubmitHttp,
  handleSseHttp,
  releaseInflightFromEvent,
  isTerminalInvokeEvent,
  isTerminalStreamFrame,
  quotaKey,
  TASK_AGENT_INVOKE,
  STREAM_FRAME_TYPES,
  DEFAULT_LIMITS,
  createMemoryKv,
  createTenantRateLimiter,
} = require('./gateway');

function rateLimiterDeps(kv, limits, nowMs) {
  const t = nowMs;
  return {
    kv,
    rateLimiter: createTenantRateLimiter({
      kv,
      limits,
      now: () => t,
    }),
    nowMs: t,
  };
}

async function main() {
  const src = fs.readFileSync(path.join(__dirname, 'gateway.js'), 'utf8');
  assert.ok(!/\brequire\(['"]pg['"]\)/.test(src), 'gateway must not require pg');
  assert.ok(!/set_config/.test(src), 'gateway must not call set_config');
  assert.ok(!/AURA_DATABASE_HOST/.test(src), 'gateway must not reference AURA_DATABASE_HOST');
  assert.ok(!/\.query\s*\(/.test(src), 'gateway must not call .query(');

  const id1 = issueRunId(1_700_000_000_000);
  const id2 = issueRunId(1_700_000_000_001);
  assert.ok(isUuidV7(id1), `expected uuidv7 got ${id1}`);
  assert.ok(isUuidV7(id2));
  assert.notStrictEqual(id1, id2);

  assert.strictEqual(
    buildStreamSubject('019a0000-0000-7000-8000-000000000001'),
    'aura.stream.019a0000-0000-7000-8000-000000000001',
  );
  assert.throws(() => buildStreamSubject('abc*'), /run_id_invalid/);
  assert.throws(
    () => assertExactStreamSubject('aura.stream.>', '019a0000-0000-7000-8000-000000000001'),
    /stream_subject_mismatch|stream_wildcard/,
  );

  assert.strictEqual(validatePrincipal(null).ok, false);
  assert.strictEqual(validatePrincipal({ id: 'u' }).ok, false);
  assert.strictEqual(validatePrincipal({ id: 'u', tenant_id: 't' }).ok, true);

  const registry = createRunRegistry();
  const principal = { id: 'user-1', tenant_id: 'tenant-a' };
  const other = { id: 'user-2', tenant_id: 'tenant-a' };
  const crossTenant = { id: 'user-1', tenant_id: 'tenant-b' };

  const published = [];
  const accepted = await submitAgentInvoke(
    {
      agent: 'demo',
      version: '1.0.0',
      session_id: 'sess-1',
      stream: true,
      input: { text: 'hello' },
    },
    principal,
    {
      registry,
      publishTask: async (subject, task) => {
        published.push({ subject, task });
      },
    },
  );
  assert.ok(isUuidV7(accepted.run_id));
  assert.strictEqual(accepted.stream, true);
  assert.strictEqual(accepted.stream_subject, buildStreamSubject(accepted.run_id));
  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].subject, TASK_AGENT_INVOKE);
  assert.strictEqual(published[0].task.run_id, accepted.run_id);

  const kvBridge = createMemoryKv();
  const rlBridge = createTenantRateLimiter({ kv: kvBridge });
  const frames = [];
  const bridge = await openStreamBridge(
    accepted.run_id,
    principal,
    {
      registry,
      rateLimiter: rlBridge,
      subscribeStream: async (subject, onFrame) => {
        assert.strictEqual(subject, buildStreamSubject(accepted.run_id));
        await onFrame({
          type: 'run.started',
          run_id: accepted.run_id,
          session_id: 'sess-1',
          agent: 'demo',
          version: '1.0.0',
        });
        await onFrame({ type: 'token', text: 'hi' });
        await onFrame({ type: 'run.completed' });
        return { close: async () => {} };
      },
    },
    async (frame) => {
      frames.push(frame);
    },
  );
  assert.strictEqual(bridge.subject, buildStreamSubject(accepted.run_id));
  assert.deepStrictEqual(
    frames.map((f) => f.type),
    ['run.started', 'token', 'run.completed'],
  );
  assert.ok(
    frames.findIndex((f) => f.type === 'token') <
      frames.findIndex((f) => f.type === 'run.completed'),
  );
  for (const t of frames.map((f) => f.type)) {
    assert.ok(STREAM_FRAME_TYPES.includes(t));
  }

  let forbidden = false;
  try {
    await openStreamBridge(
      accepted.run_id,
      other,
      { registry, subscribeStream: async () => ({ close: async () => {} }) },
      async () => {},
    );
  } catch (err) {
    forbidden = err.status === 403 && err.message === 'principal_forbidden';
  }
  assert.ok(forbidden);

  let tenantForbidden = false;
  try {
    await openStreamBridge(
      accepted.run_id,
      crossTenant,
      { registry, subscribeStream: async () => ({ close: async () => {} }) },
      async () => {},
    );
  } catch (err) {
    tenantForbidden = err.status === 403;
  }
  assert.ok(tenantForbidden);

  let missing = false;
  try {
    await openStreamBridge(
      '019a0000-0000-7000-8000-00000000dead',
      principal,
      { registry, subscribeStream: async () => ({ close: async () => {} }) },
      async () => {},
    );
  } catch (err) {
    missing = err.status === 404 && err.message === 'run_not_found';
  }
  assert.ok(missing);

  const wsOk = authorizeWs(accepted.run_id, principal, registry);
  assert.strictEqual(wsOk.ok, true);
  const wsDeny = authorizeWs(accepted.run_id, other, registry);
  assert.strictEqual(wsDeny.ok, false);
  assert.strictEqual(wsDeny.status, 403);

  assert.strictEqual(formatSseFrame({ type: 'token', text: 'x' }), 'data: {"type":"token","text":"x"}\n\n');

  let idOnly = false;
  try {
    await submitAgentInvoke(
      { agent: 'a', version: '1', bundle: { uri: 'x' } },
      principal,
      { registry, publishTask: async () => {} },
    );
  } catch (err) {
    idOnly = err.message === 'identifiers_only';
  }
  assert.ok(idOnly);

  const httpReg = createRunRegistry();
  const pubs = [];
  const sub = await handleSubmitHttp(
    {
      principal,
      body: JSON.stringify({ agent: 'demo', version: '1.0.0', input: { text: 'ping' } }),
    },
    {
      registry: httpReg,
      publishTask: async (subject, task) => {
        pubs.push({ subject, task });
      },
    },
  );
  assert.strictEqual(sub.status, 202);
  assert.ok(isUuidV7(sub.body.run_id));
  assert.strictEqual(pubs[0].subject, TASK_AGENT_INVOKE);

  const sseRes = await handleSseHttp(
    { run_id: sub.body.run_id, principal },
    {
      registry: httpReg,
      subscribeStream: async (_subject, onFrame) => {
        await onFrame({ type: 'token', text: 'ok' });
        return { close: async () => {} };
      },
    },
  );
  assert.strictEqual(sseRes.status, 200);
  assert.strictEqual(sseRes.contentType, 'text/event-stream');
  assert.ok(sseRes.frames.some((f) => f.includes('"type":"token"')));

  const denySse = await handleSseHttp(
    { run_id: sub.body.run_id, principal: other },
    {
      registry: httpReg,
      subscribeStream: async () => ({ close: async () => {} }),
    },
  );
  assert.strictEqual(denySse.status, 403);

  // --- Fair Queue / Rate Limit (§2.2 · V3.2) ---
  assert.strictEqual(DEFAULT_LIMITS.ratePerSec, 10);
  assert.strictEqual(DEFAULT_LIMITS.burst, 30);
  assert.strictEqual(DEFAULT_LIMITS.maxInflight, 20);

  const limitsTight = { ratePerSec: 1, burst: 1, maxInflight: 1 };
  const kvShared = createMemoryKv();
  const regA = createRunRegistry();
  const pubsA = [];
  const tenantA = { id: 'noisy', tenant_id: 'tenant-noisy' };
  const tenantB = { id: 'quiet', tenant_id: 'tenant-quiet' };
  const t = 1_700_000_000_000;

  const okA = await submitAgentInvoke(
    { agent: 'demo', version: '1.0.0' },
    tenantA,
    {
      registry: regA,
      publishTask: async (_s, task) => {
        pubsA.push(task);
      },
      ...rateLimiterDeps(kvShared, limitsTight, t),
    },
  );
  assert.ok(isUuidV7(okA.run_id));
  assert.strictEqual(pubsA.length, 1);

  let limited = false;
  try {
    await submitAgentInvoke(
      { agent: 'demo', version: '1.0.0' },
      tenantA,
      {
        registry: regA,
        publishTask: async () => {
          throw new Error('must_not_publish');
        },
        ...rateLimiterDeps(kvShared, limitsTight, t),
      },
    );
  } catch (err) {
    limited =
      err.status === 429 &&
      (err.message === 'rate_limited' || err.message === 'max_inflight_exceeded');
  }
  assert.ok(limited, 'noisy tenant must get 429 without publish');

  const regB = createRunRegistry();
  const pubsB = [];
  const okB = await submitAgentInvoke(
    { agent: 'demo', version: '1.0.0' },
    tenantB,
    {
      registry: regB,
      publishTask: async (_s, task) => {
        pubsB.push(task);
      },
      ...rateLimiterDeps(kvShared, limitsTight, t),
    },
  );
  assert.ok(isUuidV7(okB.run_id));
  assert.strictEqual(pubsB.length, 1, 'quiet tenant must still publish');

  const rlA = createTenantRateLimiter({
    kv: kvShared,
    limits: limitsTight,
    now: () => t,
  });
  await rlA.release(tenantA.tenant_id, okA.run_id);
  const okA2 = await submitAgentInvoke(
    { agent: 'demo', version: '1.0.0' },
    tenantA,
    {
      registry: regA,
      publishTask: async () => {},
      ...rateLimiterDeps(kvShared, limitsTight, t + 2000),
    },
  );
  assert.ok(isUuidV7(okA2.run_id));

  const kv2 = createMemoryKv();
  const httpReg2 = createRunRegistry();
  const rlDeps = rateLimiterDeps(kv2, limitsTight, t);
  await handleSubmitHttp(
    { principal: tenantA, body: { agent: 'demo', version: '1' } },
    {
      registry: httpReg2,
      publishTask: async () => {},
      ...rlDeps,
    },
  );
  const denied = await handleSubmitHttp(
    { principal: tenantA, body: { agent: 'demo', version: '1' } },
    {
      registry: httpReg2,
      publishTask: async () => {
        throw new Error('nope');
      },
      ...rlDeps,
    },
  );
  assert.strictEqual(denied.status, 429);
  assert.ok(denied.body.retry_after_ms >= 1);

  // --- done/error inflight release (멱등) ---
  assert.ok(isTerminalInvokeEvent('aura.events.agent.invoke.done'));
  assert.ok(isTerminalInvokeEvent('aura.events.agent.invoke.error'));
  assert.ok(isTerminalStreamFrame({ type: 'run.completed' }));
  assert.ok(isTerminalStreamFrame({ type: 'error' }));
  assert.ok(!isTerminalInvokeEvent('aura.events.agent.invoke.other'));

  const kvRel = createMemoryKv();
  const limitsRel = { ratePerSec: 10, burst: 5, maxInflight: 2 };
  const nowRel = 1_700_000_100_000;
  const rlRel = createTenantRateLimiter({
    kv: kvRel,
    limits: limitsRel,
    now: () => nowRel,
  });
  const runDone = '019a0000-0000-7000-8000-00000000done';
  const runErr = '019a0000-0000-7000-8000-00000000err0';
  assert.ok((await rlRel.tryAcquire('tenant-rel', runDone)).ok);
  assert.ok((await rlRel.tryAcquire('tenant-rel', runErr)).ok);
  let st = (await kvRel.get(quotaKey('tenant-rel'))).value;
  assert.strictEqual(st.inflight, 2);

  const relDone = await releaseInflightFromEvent(
    'aura.events.agent.invoke.done',
    'tenant-rel',
    runDone,
    { rateLimiter: rlRel },
  );
  assert.strictEqual(relDone.released, true);
  st = (await kvRel.get(quotaKey('tenant-rel'))).value;
  assert.strictEqual(st.inflight, 1);
  assert.ok(!st.runs[runDone]);

  const relDone2 = await releaseInflightFromEvent(
    'aura.events.agent.invoke.done',
    'tenant-rel',
    runDone,
    { rateLimiter: rlRel },
  );
  assert.strictEqual(relDone2.released, false, 'release must be idempotent');
  st = (await kvRel.get(quotaKey('tenant-rel'))).value;
  assert.strictEqual(st.inflight, 1);

  const relErr = await releaseInflightFromEvent(
    'aura.events.agent.invoke.error',
    'tenant-rel',
    runErr,
    { rateLimiter: rlRel },
  );
  assert.strictEqual(relErr.released, true);
  st = (await kvRel.get(quotaKey('tenant-rel'))).value;
  assert.strictEqual(st.inflight, 0);

  const skip = await releaseInflightFromEvent(
    'aura.events.other',
    'tenant-rel',
    runDone,
    { rateLimiter: rlRel },
  );
  assert.strictEqual(skip.skipped, true);

  // stream terminal also releases (first-fire-wins)
  const kvBridge2 = createMemoryKv();
  const rlBridge2 = createTenantRateLimiter({
    kv: kvBridge2,
    limits: limitsRel,
    now: () => nowRel,
  });
  const regBridge = createRunRegistry();
  const runBridge = '019a0000-0000-7000-8000-00000000brdg';
  assert.ok((await rlBridge2.tryAcquire('tenant-bridge', runBridge)).ok);
  regBridge.register(runBridge, { id: 'p1', tenant_id: 'tenant-bridge' });
  await openStreamBridge(
    runBridge,
    { id: 'p1', tenant_id: 'tenant-bridge' },
    {
      registry: regBridge,
      rateLimiter: rlBridge2,
      subscribeStream: async (_s, onFrame) => {
        await onFrame({ type: 'token', text: 'x' });
        await onFrame({ type: 'run.completed' });
        await onFrame({ type: 'error', message: 'late' });
        return { close: async () => {} };
      },
    },
    async () => {},
  );
  st = (await kvBridge2.get(quotaKey('tenant-bridge'))).value;
  assert.strictEqual(st.inflight, 0, 'stream terminal must release once');
  assert.ok(!st.runs[runBridge]);

  console.log('gateway.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});