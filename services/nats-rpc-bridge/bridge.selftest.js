'use strict';

const assert = require('assert');
const {
  QUEUE_GROUP,
  SUBJECT_TO_FUNCTION,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_INFLIGHT,
  functionForSubject,
  invokeFission,
  handleNatsMessage,
  createInflightGate,
  dispatchNatsMessage,
  startBridge,
} = require('./bridge');

function sc() {
  return {
    decode: (d) => {
      if (Buffer.isBuffer(d) || d instanceof Uint8Array) {
        return Buffer.from(d).toString('utf8');
      }
      return String(d);
    },
    encode: (s) => Buffer.from(String(s), 'utf8'),
  };
}

async function testMapping() {
  assert.strictEqual(QUEUE_GROUP, 'aura-rpc-bridge');
  assert.strictEqual(
    functionForSubject('aura.rpc.memory.recall'),
    'aura-memory-recall',
  );
  assert.strictEqual(
    functionForSubject('aura.rpc.control.resolve'),
    'aura-control-resolve',
  );
  assert.strictEqual(functionForSubject('aura.rpc.mcp.tool'), 'aura-mcp-invoke-rpc');
  assert.strictEqual(functionForSubject('aura.rpc.mcp.tool', 'nodejs'), 'aura-mcp-invoke-rpc');
  assert.strictEqual(functionForSubject('aura.rpc.mcp.tool', 'python'), 'aura-mcp-invoke-rpc-py');
  assert.strictEqual(functionForSubject('aura.rpc.unknown'), null);
  assert.deepStrictEqual(Object.keys(SUBJECT_TO_FUNCTION).sort(), [
    'aura.rpc.control.resolve',
    'aura.rpc.mcp.tool',
    'aura.rpc.memory.recall',
  ]);
}

async function testInvokeHttp() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'memory.recall.done', ok: true }),
    };
  };
  const out = await invokeFission(
    'aura-memory-recall',
    { tenant_id: 't1', query: 'hi' },
    { routerUrl: 'http://router-internal.fission.svc:8889', fetchImpl },
  );
  assert.strictEqual(out.status, 200);
  assert.ok(out.body.includes('memory.recall.done'));
  assert.strictEqual(
    calls[0].url,
    'http://router-internal.fission.svc:8889/fission-function/aura-memory-recall',
  );
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.signal, 'fetch must pass AbortSignal');
  assert.ok(DEFAULT_FETCH_TIMEOUT_MS >= 1000);
  assert.ok(DEFAULT_MAX_INFLIGHT >= 1);
}

async function testFetchTimeoutAbort() {
  let sawAbort = false;
  const fetchImpl = async (_url, init) => {
    assert.ok(init.signal);
    await new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      });
    });
  };
  await assert.rejects(
    () =>
      invokeFission('aura-memory-recall', '{}', {
        fetchImpl,
        fetchTimeoutMs: 20,
        routerUrl: 'http://router-internal.fission.svc:8889',
      }),
    /aborted|AbortError|timeout/i,
  );
  assert.ok(sawAbort);
}

async function testDispatchParallelNoHol() {
  const order = [];
  const gate = createInflightGate(8);
  const slowDone = new Promise((resolve) => {
    dispatchNatsMessage(
      {
        subject: 'aura.rpc.mcp.tool',
        data: Buffer.from('{}'),
        respond: () => order.push('slow'),
      },
      {
        sc: sc(),
        invoke: async () => {
          order.push('slow-start');
          await new Promise((r) => setTimeout(r, 40));
          return { status: 200, body: '{"ok":true}' };
        },
      },
      gate,
    ).then(resolve);
  });
  const fastDone = new Promise((resolve) => {
    dispatchNatsMessage(
      {
        subject: 'aura.rpc.control.resolve',
        data: Buffer.from('{}'),
        respond: () => order.push('fast'),
      },
      {
        sc: sc(),
        invoke: async () => {
          order.push('fast-start');
          return { status: 200, body: '{"ok":true}' };
        },
      },
      gate,
    ).then(resolve);
  });
  await Promise.all([slowDone, fastDone]);
  assert.ok(order.indexOf('fast') < order.indexOf('slow'), order);
  assert.ok(order.includes('slow-start'));
  assert.ok(order.includes('fast-start'));
}

async function testInflightCap() {
  const gate = createInflightGate(1);
  let concurrent = 0;
  let peak = 0;
  const run = () =>
    new Promise((resolve) => {
      dispatchNatsMessage(
        {
          subject: 'aura.rpc.memory.recall',
          data: Buffer.from('{}'),
          respond: () => {},
        },
        {
          sc: sc(),
          invoke: async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await new Promise((r) => setTimeout(r, 30));
            concurrent -= 1;
            return { status: 200, body: '{}' };
          },
        },
        gate,
      ).then(resolve);
    });
  await Promise.all([run(), run(), run()]);
  assert.strictEqual(peak, 1);
}

async function testRespondOk() {
  let replied;
  const out = await handleNatsMessage(
    {
      subject: 'aura.rpc.control.resolve',
      data: Buffer.from(JSON.stringify({ tenant_id: 't' })),
      respond: (b) => {
        replied = Buffer.from(b).toString('utf8');
      },
    },
    {
      sc: sc(),
      invoke: async (fn, payload) => {
        assert.strictEqual(fn, 'aura-control-resolve');
        assert.ok(String(payload).includes('tenant_id'));
        return { status: 200, body: JSON.stringify({ type: 'control.resolve.done', ok: true }) };
      },
    },
  );
  assert.strictEqual(out.status, 200);
  assert.ok(replied.includes('control.resolve.done'));
}

async function testUnknownSubject() {
  let replied;
  const out = await handleNatsMessage(
    {
      subject: 'aura.rpc.nope',
      data: Buffer.from('{}'),
      respond: (b) => {
        replied = Buffer.from(b).toString('utf8');
      },
    },
    { sc: sc() },
  );
  assert.strictEqual(out.status, 404);
  assert.ok(replied.includes('unknown_rpc_subject'));
}

async function testInvokeErrorBody() {
  let replied;
  const out = await handleNatsMessage(
    {
      subject: 'aura.rpc.mcp.tool',
      data: Buffer.from('{}'),
      respond: (b) => {
        replied = Buffer.from(b).toString('utf8');
      },
    },
    {
      sc: sc(),
      invoke: async () => {
        throw new Error('router_down');
      },
    },
  );
  assert.strictEqual(out.status, 502);
  assert.ok(replied.includes('fission_invoke_failed'));
  assert.ok(replied.includes('router_down'));
}

async function testStartBridgeSubscribes() {
  const subscribed = [];
  const fakeNc = {
    subscribe(subject, opts) {
      subscribed.push({ subject, queue: opts.queue });
      return (async function* empty() {
        /* no messages */
      })();
    },
  };
  const { queue, subjects } = await startBridge({
    queue: 'aura-rpc-bridge',
    connect: async () => ({ nc: fakeNc, sc: sc() }),
    invoke: async () => ({ status: 200, body: '{}' }),
  });
  assert.strictEqual(queue, 'aura-rpc-bridge');
  assert.strictEqual(subjects.length, 3);
  assert.strictEqual(subscribed.length, 3);
  assert.ok(subscribed.every((s) => s.queue === 'aura-rpc-bridge'));
}

(async () => {
  await testMapping();
  await testInvokeHttp();
  await testFetchTimeoutAbort();
  await testDispatchParallelNoHol();
  await testInflightCap();
  await testRespondOk();
  await testUnknownSubject();
  await testInvokeErrorBody();
  await testStartBridgeSubscribes();
  console.log('OK: nats-rpc-bridge.selftest');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
