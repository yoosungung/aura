'use strict';

const assert = require('assert');
const { maskSecrets, maskSecretsForLog, MASK } = require('./secrets-mask');

function main() {
  const nested = {
    tenant_id: 't1',
    api_key: 'sk-live-xyz',
    cfg: { token: 'bearer-abc', ok: 1 },
    secrets: { db: 'postgres://u:p@h' },
    nested: { authorization: 'Basic x', label: 'safe' },
    password: 'hunter2',
  };
  const masked = maskSecrets(nested);
  assert.strictEqual(masked.api_key, MASK);
  assert.strictEqual(masked.password, MASK);
  assert.strictEqual(masked.secrets, MASK);
  assert.strictEqual(masked.cfg.token, MASK);
  assert.strictEqual(masked.cfg.ok, 1);
  assert.strictEqual(masked.nested.authorization, MASK);
  assert.strictEqual(masked.nested.label, 'safe');
  assert.strictEqual(masked.tenant_id, 't1');
  assert.notStrictEqual(nested.api_key, MASK, 'must clone, not mutate input');

  const log = maskSecretsForLog({ client_secret: 'x', count: 2 });
  assert.ok(log.includes(MASK));
  assert.ok(!log.includes('x'));

  assert.strictEqual(maskSecrets(null), null);
  assert.deepStrictEqual(maskSecrets([{ token: 't' }]), [{ token: MASK }]);

  console.log('secrets-mask.selftest: PASS');
}

main();