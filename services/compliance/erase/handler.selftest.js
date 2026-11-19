'use strict';

const assert = require('assert');
const { runEraseOnce, assertNoDecryptableCiphertext } = require('./handler');

function makeKeyStore(initial) {
  const keys = new Map(Object.entries(initial || {}));
  return {
    async has(kid) {
      return keys.has(kid);
    },
    async destroy(kid) {
      keys.delete(kid);
      return { destroyed: true, kid };
    },
    async decrypt(kid, ciphertext) {
      if (!keys.has(kid)) return null;
      return `plain:${ciphertext}`;
    },
  };
}

async function main() {
  const kid = 'tenant:t1:user:u1:v1';
  const keyStore = makeKeyStore({ [kid]: Buffer.from('dek') });
  const cacheCalls = [];
  const pgCalls = [];
  const objCalls = [];

  assert.strictEqual(await keyStore.decrypt(kid, 'cipher-blob'), 'plain:cipher-blob');

  const result = await runEraseOnce(
    {
      keyStore,
      invalidateSecretsCache: async (scope) => {
        cacheCalls.push(scope);
      },
      redactHotPg: async (scope) => {
        pgCalls.push(scope);
        return { deleted: 3 };
      },
      deleteObject: async ({ key }) => {
        objCalls.push(key);
        return { ok: true };
      },
    },
    {
      tenant_id: 't1',
      payload: {
        scope: 'user',
        user_id: 'u1',
        request_id: 'req-1',
        content_refs: [
          {
            bucket: 'aura-content',
            key: 'tenants/t1/refs/a',
            enc: { kid },
          },
        ],
        ciphertexts: [{ kid, ciphertext: 'cipher-blob' }],
      },
    },
  );

  assert.strictEqual(result.status, 'erased');
  assert.strictEqual(result.kms_product, 'openbao-transit');
  assert.deepStrictEqual(result.destroyed_kids, [kid]);
  assert.strictEqual(await keyStore.has(kid), false);
  assert.strictEqual(await keyStore.decrypt(kid, 'cipher-blob'), null);
  assert.strictEqual(pgCalls[0].tenant_id, 't1');
  assert.strictEqual(pgCalls[0].user_id, 'u1');
  assert.deepStrictEqual(objCalls, ['tenants/t1/refs/a']);
  assert.deepStrictEqual(cacheCalls[0].kids, [kid]);
  assert.ok(result.steps_completed.indexOf('shred_keys') < result.steps_completed.indexOf('pg_redact'));
  assert.ok(
    result.steps_completed.indexOf('shred_keys') < result.steps_completed.indexOf('delete_objects'),
  );
  assert.strictEqual(result.event.subject, 'aura.events.compliance.erase.done');

  await assertNoDecryptableCiphertext(keyStore, [{ kid, ciphertext: 'cipher-blob' }]);

  await assert
    .rejects(
      () =>
        assertNoDecryptableCiphertext(
          {
            async decrypt() {
              return 'leaked';
            },
          },
          [{ kid, ciphertext: 'x' }],
        ),
      /decryptable_ciphertext_remains/,
    );

  console.log('handler.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
