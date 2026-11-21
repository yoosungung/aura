'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MAX_INFLIGHT,
  TASK_SUBJECTS,
  functionForTask,
  topicsForTask,
  parseRuntime,
  handleTaskMessage,
  invokeFission,
  createInflightGate,
  dispatchTaskMessage,
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

async function testMappingAndHandle() {
  assert.deepStrictEqual(TASK_SUBJECTS.slice().sort(), [
    'aura.tasks.agent.invoke',
    'aura.tasks.mcp.invoke',
  ]);
  assert.strictEqual(functionForTask('aura.tasks.agent.invoke', 'nodejs'), 'aura-agent-invoke');
  assert.strictEqual(functionForTask('aura.tasks.agent.invoke', 'python'), 'aura-agent-invoke-py');
  assert.strictEqual(functionForTask('aura.tasks.mcp.invoke', 'python'), 'aura-mcp-invoke-py');
  assert.strictEqual(
    functionForTask('aura.tasks.agent.invoke', 'custom', 'aura-agent-invoke-demo'),
    'aura-agent-invoke-demo',
  );
  assert.strictEqual(
    functionForTask('aura.tasks.mcp.invoke', 'custom', 'aura-mcp-invoke-demo'),
    'aura-mcp-invoke-demo',
  );
  assert.strictEqual(
    functionForTask('aura.tasks.agent.invoke', 'custom', 'aura-agent-invoke-py'),
    null,
  );
  assert.strictEqual(
    functionForTask('aura.tasks.mcp.invoke', 'custom', 'aura-mcp-invoke-rpc-demo'),
    null,
  );
  assert.strictEqual(functionForTask('aura.tasks.agent.invoke', 'custom', 'other'), null);
  assert.strictEqual(
    functionForTask('aura.tasks.agent.invoke', 'nodejs', 'aura-agent-invoke-evil'),
    'aura-agent-invoke',
  );
  assert.strictEqual(parseRuntime('{"runtime":"python"}'), 'python');
  assert.strictEqual(parseRuntime('{}'), 'nodejs');

  const topics = topicsForTask('aura.tasks.agent.invoke');
  assert.strictEqual(topics.respTopic, 'aura.events.agent.invoke.done');

  const published = [];
  const out = await handleTaskMessage(
    {
      subject: 'aura.tasks.agent.invoke',
      data: Buffer.from(JSON.stringify({ runtime: 'python', run_id: 'r1' })),
      ack: async () => {},
    },
    {
      sc: sc(),
      invoke: async (fn, payload) => {
        assert.strictEqual(fn, 'aura-agent-invoke-py');
        return { status: 200, body: JSON.stringify({ type: 'agent.invoke.done', ok: true }) };
      },
      publish: async (subj, body) => {
        published.push({ subj, body });
      },
    },
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(published[0].subj, 'aura.events.agent.invoke.done');

  const calls = [];
  await invokeFission('aura-agent-invoke', { a: 1 }, {
    routerUrl: 'http://router.test:8889',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => '{}' };
    },
  });
  assert.ok(calls[0].url.includes('/fission-function/aura-agent-invoke'));

  const customCalls = [];
  const customOut = await handleTaskMessage(
    {
      subject: 'aura.tasks.agent.invoke',
      data: Buffer.from(
        JSON.stringify({ runtime: 'custom', function: 'aura-agent-invoke-demo' }),
      ),
      ack: async () => {},
    },
    {
      sc: sc(),
      invoke: async (fn) => {
        customCalls.push(fn);
        return { status: 200, body: JSON.stringify({ ok: true }) };
      },
      publish: async () => {},
    },
  );
  assert.strictEqual(customOut.function, 'aura-agent-invoke-demo');
  assert.deepStrictEqual(customCalls, ['aura-agent-invoke-demo']);

  const denied = [];
  const deniedOut = await handleTaskMessage(
    {
      subject: 'aura.tasks.agent.invoke',
      data: Buffer.from(JSON.stringify({ runtime: 'custom', function: '../x' })),
      ack: async () => {},
    },
    {
      sc: sc(),
      invoke: async () => {
        throw new Error('must_not_invoke');
      },
      publish: async (subj, body) => {
        denied.push({ subj, body });
      },
    },
  );
  assert.strictEqual(deniedOut.ok, false);
  assert.strictEqual(denied[0].body.error, 'function_not_allowed');
}

async function testInflightDefaults() {
  assert.ok(
    DEFAULT_MAX_INFLIGHT >= 16 && DEFAULT_MAX_INFLIGHT <= 32,
    `DEFAULT_MAX_INFLIGHT should be 16–32, got ${DEFAULT_MAX_INFLIGHT}`,
  );
}

async function testDispatchParallelNoHol() {
  const order = [];
  const gate = createInflightGate(8);
  const slowDone = dispatchTaskMessage(
    {
      subject: 'aura.tasks.agent.invoke',
      data: Buffer.from('{}'),
      ack: async () => order.push('slow'),
    },
    {
      sc: sc(),
      invoke: async () => {
        order.push('slow-start');
        await new Promise((r) => setTimeout(r, 40));
        return { status: 200, body: '{"ok":true}' };
      },
      publish: async () => {},
    },
    gate,
  );
  const fastDone = dispatchTaskMessage(
    {
      subject: 'aura.tasks.mcp.invoke',
      data: Buffer.from('{}'),
      ack: async () => order.push('fast'),
    },
    {
      sc: sc(),
      invoke: async () => {
        order.push('fast-start');
        return { status: 200, body: '{"ok":true}' };
      },
      publish: async () => {},
    },
    gate,
  );
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
    dispatchTaskMessage(
      {
        subject: 'aura.tasks.agent.invoke',
        data: Buffer.from('{}'),
        ack: async () => {},
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
        publish: async () => {},
      },
      gate,
    );
  await Promise.all([run(), run(), run()]);
  assert.strictEqual(peak, 1);
  assert.strictEqual(gate.active, 0);
}

async function testConsumeLoopDoesNotAwaitHandle() {
  const src = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
  assert.ok(/void dispatchTaskMessage/.test(src), 'loop must fire-and-forget dispatch');
  assert.ok(
    !/for await \(const m of messages\) \{\s*try \{\s*await handleTaskMessage/.test(src),
    'loop must not await handleTaskMessage inside for-await',
  );
  assert.ok(/createInflightGate/.test(src), 'must use createInflightGate');
}

async function main() {
  await testMappingAndHandle();
  await testInflightDefaults();
  await testDispatchParallelNoHol();
  await testInflightCap();
  await testConsumeLoopDoesNotAwaitHandle();
  console.log('nats-task-bridge.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
