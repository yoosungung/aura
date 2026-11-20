'use strict';

const assert = require('assert');
const { createCheckpointStore } = require('./checkpoints');

async function main() {
  const log = [];
  const store = createCheckpointStore({
    query: async (text, params) => {
      log.push({ text, params });
      if (/set_config/.test(text)) {
        assert.ok(text.includes('true'), 'must use is_local=true');
        return { rows: [] };
      }
      if (/INSERT INTO agent_checkpoints/.test(text)) {
        assert.ok(!/memory_/.test(text));
        return { rows: [{ id: 'id-1', seq: params[4] }] };
      }
      if (/FROM agent_checkpoints/.test(text)) {
        return {
          rows: [
            {
              id: 'id-1',
              run_id: 'run-1',
              seq: 1,
              kind: 'turn',
              state: { step: 1 },
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const w = await store.write({
    tenant_id: '11111111-1111-1111-1111-111111111111',
    run_id: 'run-1',
    session_id: 's1',
    principal_id: 'p1',
    seq: 1,
    kind: 'turn',
    state: { step: 1 },
  });
  assert.strictEqual(w.seq, 1);

  await assert.rejects(
    () =>
      store.write({
        tenant_id: '11111111-1111-1111-1111-111111111111',
        run_id: 'run-1',
        principal_id: 'p1',
        seq: 2,
        kind: 'nope',
        state: {},
      }),
    /kind_invalid/,
  );

  await assert.rejects(
    () =>
      store.write({
        tenant_id: '11111111-1111-1111-1111-111111111111',
        run_id: 'run-1',
        principal_id: 'p1',
        seq: 2,
        kind: 'final',
        state: { secrets: { k: 'v' } },
      }),
    /secrets_plaintext_forbidden/,
  );

  const latest = await store.loadLatest(
    '11111111-1111-1111-1111-111111111111',
    'run-1',
  );
  assert.strictEqual(latest.kind, 'turn');
  assert.ok(log.some((e) => /set_config/.test(e.text)));

  console.log('OK: checkpoints.selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
