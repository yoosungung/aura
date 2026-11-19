'use strict';

const assert = require('assert');
const {
  DLQ_STREAM,
  DLQ_SUBJECT_PREFIX,
  DEFAULT_MAX_BATCH,
  parseDlqEnvelope,
  buildReplayPublish,
  planReplay,
  selectRecords,
} = require('./replay');

function sampleEnvelope(overrides = {}) {
  return {
    id: 'dlq-1',
    src: 'aura.tasks.agent.invoke',
    tries: 5,
    path: 'term',
    echo: { run_id: 'r1', tenant_cd: 't1' },
    ...overrides,
  };
}

function testConstants() {
  assert.strictEqual(DLQ_STREAM, 'AURA_DLQ');
  assert.strictEqual(DLQ_SUBJECT_PREFIX, 'aura.dlq.');
  assert.strictEqual(DEFAULT_MAX_BATCH, 20);
}

function testParseEnvelopeObject() {
  const env = parseDlqEnvelope(sampleEnvelope());
  assert.strictEqual(env.id, 'dlq-1');
  assert.strictEqual(env.src, 'aura.tasks.agent.invoke');
  assert.strictEqual(env.path, 'term');
  assert.strictEqual(env.tries, 5);
  assert.deepStrictEqual(env.payload, { run_id: 'r1', tenant_cd: 't1' });
}

function testParseEnvelopeJsonString() {
  const env = parseDlqEnvelope(JSON.stringify(sampleEnvelope({ id: 's2' })));
  assert.strictEqual(env.id, 's2');
  assert.strictEqual(env.src, 'aura.tasks.agent.invoke');
}

function testParseEnvelopePayloadAlias() {
  const env = parseDlqEnvelope({
    id: 'p1',
    src: 'aura.tasks.memory.store',
    path: 'term',
    payload: { x: 1 },
  });
  assert.deepStrictEqual(env.payload, { x: 1 });
}

function testParseRejectsMissingSrc() {
  assert.throws(
    () => parseDlqEnvelope({ id: 'x', path: 'term', echo: {} }),
    (e) => e.code === 'src_required',
  );
}

function testParseRejectsDlqSrc() {
  assert.throws(
    () =>
      parseDlqEnvelope({
        id: 'x',
        src: 'aura.dlq.tasks.agent.invoke',
        path: 'term',
        echo: {},
      }),
    (e) => e.code === 'src_is_dlq',
  );
}

function testBuildReplayPublish() {
  const pub = buildReplayPublish(parseDlqEnvelope(sampleEnvelope()));
  assert.strictEqual(pub.subject, 'aura.tasks.agent.invoke');
  assert.strictEqual(JSON.parse(pub.data).run_id, 'r1');
  assert.ok(!pub.subject.startsWith('aura.dlq.'));
}

function testBuildReplayRejectsDlqTarget() {
  assert.throws(
    () =>
      buildReplayPublish({
        id: 'x',
        src: 'aura.dlq.tasks.x',
        path: 'term',
        payload: {},
      }),
    (e) => e.code === 'src_is_dlq',
  );
}

function testSelectBySeqAndId() {
  const records = [
    { seq: 10, subject: 'aura.dlq.tasks.a', data: sampleEnvelope({ id: 'a' }) },
    { seq: 11, subject: 'aura.dlq.tasks.b', data: sampleEnvelope({ id: 'b', src: 'aura.tasks.b' }) },
    { seq: 12, subject: 'aura.dlq.tasks.c', data: sampleEnvelope({ id: 'c', src: 'aura.tasks.c' }) },
  ];
  const bySeq = selectRecords(records, { seqs: [11] });
  assert.strictEqual(bySeq.length, 1);
  assert.strictEqual(bySeq[0].seq, 11);
  const byId = selectRecords(records, { ids: ['c'] });
  assert.strictEqual(byId.length, 1);
  assert.strictEqual(byId[0].data.id, 'c');
  const byPrefix = selectRecords(records, { src_prefix: 'aura.tasks.b' });
  assert.strictEqual(byPrefix.length, 1);
}

function testPlanDryRun() {
  const records = [
    { seq: 1, subject: 'aura.dlq.tasks.a', data: sampleEnvelope({ id: 'a' }) },
    { seq: 2, subject: 'aura.dlq.tasks.b', data: sampleEnvelope({ id: 'b', src: 'aura.tasks.b' }) },
  ];
  const plan = planReplay({ records, mode: 'dry_run', max_batch: 20 });
  assert.strictEqual(plan.mode, 'dry_run');
  assert.strictEqual(plan.execute, false);
  assert.strictEqual(plan.publishes.length, 2);
  assert.strictEqual(plan.publishes[0].subject, 'aura.tasks.agent.invoke');
  assert.strictEqual(plan.publishes[1].subject, 'aura.tasks.b');
  assert.strictEqual(plan.refused.length, 0);
}

function testPlanConfirmRequiresExplicit() {
  const records = [
    { seq: 1, subject: 'aura.dlq.tasks.a', data: sampleEnvelope() },
  ];
  assert.throws(
    () => planReplay({ records, mode: 'live' }),
    (e) => e.code === 'mode_invalid',
  );
  const plan = planReplay({ records, mode: 'confirm', max_batch: 20 });
  assert.strictEqual(plan.execute, true);
  assert.strictEqual(plan.publishes.length, 1);
}

function testPlanMaxBatch() {
  const records = Array.from({ length: 3 }, (_, i) => ({
    seq: i + 1,
    subject: `aura.dlq.tasks.t${i}`,
    data: sampleEnvelope({ id: `id-${i}`, src: `aura.tasks.t${i}` }),
  }));
  const plan = planReplay({ records, mode: 'dry_run', max_batch: 2 });
  assert.strictEqual(plan.publishes.length, 2);
  assert.strictEqual(plan.skipped.length, 1);
  assert.strictEqual(plan.skipped[0].reason, 'max_batch');
}

function testPlanRefusesBadEnvelope() {
  const records = [
    { seq: 1, subject: 'aura.dlq.tasks.bad', data: { id: 'bad', echo: {} } },
    {
      seq: 2,
      subject: 'aura.dlq.tasks.loop',
      data: { id: 'loop', src: 'aura.dlq.tasks.x', path: 'term', echo: {} },
    },
  ];
  const plan = planReplay({ records, mode: 'dry_run' });
  assert.strictEqual(plan.publishes.length, 0);
  assert.strictEqual(plan.refused.length, 2);
  assert.ok(plan.refused.some((r) => r.reason === 'src_required'));
  assert.ok(plan.refused.some((r) => r.reason === 'src_is_dlq'));
}

function testNoAutoInfiniteReplay() {
  // planReplay never schedules a second hop back into AURA_DLQ
  const records = [
    { seq: 1, subject: 'aura.dlq.tasks.a', data: sampleEnvelope() },
  ];
  const plan = planReplay({ records, mode: 'confirm' });
  for (const p of plan.publishes) {
    assert.ok(!p.subject.startsWith(DLQ_SUBJECT_PREFIX));
  }
  assert.strictEqual(plan.auto_loop, false);
}

function run() {
  testConstants();
  testParseEnvelopeObject();
  testParseEnvelopeJsonString();
  testParseEnvelopePayloadAlias();
  testParseRejectsMissingSrc();
  testParseRejectsDlqSrc();
  testBuildReplayPublish();
  testBuildReplayRejectsDlqTarget();
  testSelectBySeqAndId();
  testPlanDryRun();
  testPlanConfirmRequiresExplicit();
  testPlanMaxBatch();
  testPlanRefusesBadEnvelope();
  testNoAutoInfiniteReplay();
  console.log('dlq-replay.selftest: PASS');
}

run();
