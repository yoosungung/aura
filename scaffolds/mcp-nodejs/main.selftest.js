'use strict';

const assert = require('assert');
const { factory } = require('./main');

async function main() {
  const mcp = factory({ flag: 'lab' }, 'vault:ref');
  const listed = await mcp.listTools();
  assert.strictEqual(listed.ok, true);
  assert.ok(Array.isArray(listed.tools));
  assert.strictEqual(listed.tools[0].name, 'echo');

  const ran = await mcp.runTool({ tool: 'echo', input: { x: 1 } });
  assert.strictEqual(ran.ok, true);
  assert.strictEqual(ran.tag, 'scaffold-mcp');
  assert.strictEqual(ran.tool, 'echo');
  assert.strictEqual(ran.flag, 'lab');
  assert.strictEqual(ran.secrets_ref, 'vault:ref');
  console.log('mcp-nodejs scaffold selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
