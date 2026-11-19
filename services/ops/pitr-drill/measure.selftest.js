'use strict';

const assert = require('assert');
const {
  RPO_BUDGET_MS,
  RTO_BUDGET_MS,
  PHASES,
  measureDrill,
  evaluateBudgets,
  loadDrillRecord,
} = require('./measure');

function iso(msOffset, base = Date.parse('2026-11-19T06:00:00.000Z')) {
  return new Date(base + msOffset).toISOString();
}

function testBudgetsConstants() {
  assert.strictEqual(RPO_BUDGET_MS, 5 * 60 * 1000);
  assert.strictEqual(RTO_BUDGET_MS, 60 * 60 * 1000);
  assert.ok(PHASES.indexOf('restore') < PHASES.indexOf('verify'));
  assert.ok(PHASES.indexOf('verify') < PHASES.indexOf('dsn_cutover'));
}

function testMeasurePass() {
  const result = measureDrill({
    drill_id: 'lab-1',
    mode: 'lab',
    incident_at: iso(10 * 60 * 1000),
    newest_verified_at: iso(8 * 60 * 1000), // 2m data loss
    phases: {
      restore_start: iso(10 * 60 * 1000),
      replay_end: iso(10 * 60 * 1000 + 90 * 1000),
      verify_end: iso(10 * 60 * 1000 + 3 * 60 * 1000),
      dsn_cutover_end: iso(10 * 60 * 1000 + 4 * 60 * 1000),
    },
  });
  assert.strictEqual(result.rpo_ms, 2 * 60 * 1000);
  assert.strictEqual(result.rto_ms, 4 * 60 * 1000);
  assert.strictEqual(result.rpo_pass, true);
  assert.strictEqual(result.rto_pass, true);
  assert.strictEqual(result.pass, true);
  assert.ok(result.phase_ms.restore >= 0);
  assert.ok(result.phase_ms.verify >= 0);
}

function testMeasureFailRpo() {
  const result = measureDrill({
    drill_id: 'fail-rpo',
    mode: 'lab',
    incident_at: iso(20 * 60 * 1000),
    newest_verified_at: iso(10 * 60 * 1000), // 10m > 5m
    phases: {
      restore_start: iso(20 * 60 * 1000),
      verify_end: iso(20 * 60 * 1000 + 60 * 1000),
      dsn_cutover_end: iso(20 * 60 * 1000 + 90 * 1000),
    },
  });
  assert.strictEqual(result.rpo_pass, false);
  assert.strictEqual(result.pass, false);
}

function testMeasureFailRto() {
  const result = measureDrill({
    drill_id: 'fail-rto',
    mode: 'lab',
    incident_at: iso(0),
    newest_verified_at: iso(-60 * 1000),
    phases: {
      restore_start: iso(0),
      verify_end: iso(90 * 60 * 1000),
      dsn_cutover_end: iso(91 * 60 * 1000),
    },
  });
  assert.strictEqual(result.rto_pass, false);
  assert.strictEqual(result.pass, false);
}

function testEvaluateBudgets() {
  const ok = evaluateBudgets({ rpo_ms: 60_000, rto_ms: 120_000 });
  assert.deepStrictEqual(ok, { rpo_pass: true, rto_pass: true, pass: true });
  const bad = evaluateBudgets({ rpo_ms: RPO_BUDGET_MS + 1, rto_ms: 1 });
  assert.strictEqual(bad.pass, false);
}

function testRejectsMissingFields() {
  assert.throws(
    () => measureDrill({ drill_id: 'x', mode: 'lab' }),
    (e) => e && e.code === 'drill_incomplete'
  );
}

function testLoadCommittedRecord() {
  const rec = loadDrillRecord();
  assert.ok(rec && rec.drill_id);
  assert.ok(['lab', 'cluster'].includes(rec.mode));
  const measured = measureDrill(rec);
  assert.strictEqual(measured.pass, true, `committed drill must pass budgets: ${JSON.stringify(measured)}`);
}

testBudgetsConstants();
testMeasurePass();
testMeasureFailRpo();
testMeasureFailRto();
testEvaluateBudgets();
testRejectsMissingFields();
testLoadCommittedRecord();
console.log('measure.selftest: PASS');
