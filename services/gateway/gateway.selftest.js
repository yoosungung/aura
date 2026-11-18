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
  TASK_AGENT_INVOKE,
  STREAM_FRAME_TYPES,
} = require('./gateway');

async function main() {
  const src = fs.readFileSync(path.join(__dirname, 'gateway.js'), 'utf8');
  assert.ok(!/\brequire\(['"]pg['"]\)/.test(src), 'gateway must not require pg');
  assert.ok(!/set_config/.test(src), 'gateway must not call set_config');
  assert.ok(!/AURA_DATABASE_HOST/.test(src), 'gateway must not reference AURA_DATABASE_HOST');
  assert.ok(!/\.query\s*\(/.test(src), 'gateway must not call .query(');

  // UUIDv7 issuance
  const id1 = issueRunId(1_700_000_000_000);
  const id2 = issueRunId(1_700_000_000_001);
  assert.ok(isUuidV7(id1), `expected uuidv7 got ${id1}`);
  assert.ok(isUuidV7(id2));
  assert.notStrictEqual(id1, id2);
  assert.ok(id1.includes('-7'), 'version nibble must be 7');

  // stream subject: exact, no wildcards
  assert.strictEqual(
    buildStreamSubject('019a0000-0000-7000-8000-000000000001'),
    'aura.stream.019a0000-0000-7000-8000-000000000001',
  );
  assert.throws(() => buildStreamSubject('abc*'), /run_id_invalid/);
  assert.throws(() => buildStreamSubject('a.b'), /run_id_invalid/);
  assert.throws(
    () => assertExactStreamSubject('aura.stream.>', '019a0000-0000-7000-8000-000000000001'),
    /stream_subject_mismatch|stream_wildcard/,
  );

  // principal validation
  assert.strictEqual(validatePrincipal(null).ok, false);
  assert.strictEqual(validatePrincipal({ id: 'u' }).ok, false);
  assert.strictEqual(
    validatePrincipal({ id: 'u', tenant_id: 't' }).ok,
    true,
  );

  const registry = createRunRegistry();
  const principal = { id: 'user-1', tenant_id: 'tenant-a' };
  const other = { id: 'user-2', tenant_id: 'tenant-a' };
  const crossTenant = { id: 'user-1', tenant_id: 'tenant-b' };

  // submit: mint run_id, register, publish identifiers-only task
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
  assert.strictEqual(published[0].task.agent, 'demo');
  assert.strictEqual(published[0].task.version, '1.0.0');
  assert.strictEqual(published[0].task.principal.id, 'user-1');
  assert.strictEqual(published[0].task.principal.tenant_id, 'tenant-a');
  assert.ok(!published[0].task.bundle);
  assert.ok(!published[0].task.secrets);
  assert.ok(!published[0].task.cfg);

  // owner may bridge; foreign principal 403; missing run 404
  const frames = [];
  const bridge = await openStreamBridge(
    accepted.run_id,
    principal,
    {
      registry,
      subscribeStream: async (subject, onFrame) => {
        assert.strictEqual(subject, buildStreamSubject(accepted.run_id));
        assert.ok(!subject.includes('*') && !subject.includes('>'));
        // simulate agent_invoke frames (V3.1 token before completed)
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
    'token before run.completed (V3.1 bridge)',
  );
  for (const t of frames.map((f) => f.type)) {
    assert.ok(STREAM_FRAME_TYPES.includes(t));
  }

  let forbidden = false;
  try {
    await openStreamBridge(accepted.run_id, other, {
      registry,
      subscribeStream: async () => ({ close: async () => {} }),
    }, async () => {});
  } catch (err) {
    forbidden = err.status === 403 && err.message === 'principal_forbidden';
  }
  assert.ok(forbidden, 'foreign principal must get 403');

  let tenantForbidden = false;
  try {
    await openStreamBridge(accepted.run_id, crossTenant, {
      registry,
      subscribeStream: async () => ({ close: async () => {} }),
    }, async () => {});
  } catch (err) {
    tenantForbidden = err.status === 403;
  }
  assert.ok(tenantForbidden, 'cross-tenant principal must get 403');

  let missing = false;
  try {
    await openStreamBridge('019a0000-0000-7000-8000-00000000dead', principal, {
      registry,
      subscribeStream: async () => ({ close: async () => {} }),
    }, async () => {});
  } catch (err) {
    missing = err.status === 404 && err.message === 'run_not_found';
  }
  assert.ok(missing, 'unknown run_id must get 404');

  // WS authorize shares the same gate
  const wsOk = authorizeWs(accepted.run_id, principal, registry);
  assert.strictEqual(wsOk.ok, true);
  assert.strictEqual(wsOk.subject, buildStreamSubject(accepted.run_id));
  const wsDeny = authorizeWs(accepted.run_id, other, registry);
  assert.strictEqual(wsDeny.ok, false);
  assert.strictEqual(wsDeny.status, 403);

  // SSE formatting
  const sse = formatSseFrame({ type: 'token', text: 'x' });
  assert.strictEqual(sse, 'data: {"type":"token","text":"x"}\n\n');

  // identifiers-only reject
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

  // HTTP handlers
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

  console.log('gateway.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
