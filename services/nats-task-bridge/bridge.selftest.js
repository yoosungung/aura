'use strict';

const assert = require('assert');
const {
  TASK_SUBJECTS,
  functionForTask,
  topicsForTask,
  parseRuntime,
  handleTaskMessage,
  invokeFission,
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

async function main() {
  assert.deepStrictEqual(TASK_SUBJECTS.slice().sort(), [
    'aura.tasks.agent.invoke',
    'aura.tasks.mcp.invoke',
  ]);
  assert.strictEqual(functionForTask('aura.tasks.agent.invoke', 'nodejs'), 'aura-agent-invoke');
  assert.strictEqual(functionForTask('aura.tasks.agent.invoke', 'python'), 'aura-agent-invoke-py');
  assert.strictEqual(functionForTask('aura.tasks.mcp.invoke', 'python'), 'aura-mcp-invoke-py');
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

  console.log('nats-task-bridge.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
