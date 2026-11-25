'use strict';

const assert = require('assert');
const { factory } = require('./main');

async function main() {
  const agent = factory({ systemPrompt: 'test' }, 'vault:ref');
  assert.strictEqual(typeof agent.runTurn, 'function');
  const out = await agent.runTurn({ message: 'hi' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.tag, 'scaffold-agent');
  assert.strictEqual(out.echo, 'hi');
  assert.strictEqual(out.system, 'test');
  assert.strictEqual(out.secrets_ref, 'vault:ref');
  console.log('agent-nodejs scaffold selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
