'use strict';

/**
 * Offline selftest for PG PITR drill calendar policy (M5 · §9.6).
 * Ticket db568bf9.
 */

const assert = require('assert');
const path = require('path');
const {
  MIN_CADENCE,
  MIN_PER_YEAR,
  STACK_CHANGE_WINDOW_DAYS,
  quarterOf,
  quarterId,
  quarterBounds,
  plannedSlots,
  evaluateCalendar,
  loadCalendar,
  CALENDAR_PATH,
} = require('./calendar');

function throwsCode(fn, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected throw');
  assert.strictEqual(err.code, code, `expected ${code} got ${err && err.code}`);
}

// --- cadence constants ---
assert.strictEqual(MIN_CADENCE, 'quarterly');
assert.strictEqual(MIN_PER_YEAR, 4);
assert.strictEqual(STACK_CHANGE_WINDOW_DAYS, 14);

// --- quarter helpers ---
{
  const q = quarterOf('2026-11-19T09:00:00.000Z');
  assert.strictEqual(q.year, 2026);
  assert.strictEqual(q.q, 4);
  assert.strictEqual(quarterId(q), '2026-Q4');
  const b = quarterBounds(2026, 4);
  assert.strictEqual(b.start, '2026-10-01T00:00:00.000Z');
  assert.strictEqual(b.endExclusive, '2027-01-01T00:00:00.000Z');
  assert.strictEqual(b.due_by, '2026-12-01T00:00:00.000Z');
}

{
  assert.strictEqual(quarterId(quarterOf('2026-01-01T00:00:00.000Z')), '2026-Q1');
  assert.strictEqual(quarterId(quarterOf('2026-04-15T12:00:00.000Z')), '2026-Q2');
  assert.strictEqual(quarterId(quarterOf('2026-07-01T00:00:00.000Z')), '2026-Q3');
  assert.strictEqual(quarterBounds(2026, 1).due_by, '2026-03-01T00:00:00.000Z');
  assert.strictEqual(quarterBounds(2026, 2).due_by, '2026-06-01T00:00:00.000Z');
  assert.strictEqual(quarterBounds(2026, 3).due_by, '2026-09-01T00:00:00.000Z');
}

{
  const slots = plannedSlots(2026);
  assert.strictEqual(slots.length, 4);
  assert.deepStrictEqual(
    slots.map((s) => s.quarter_id),
    ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']
  );
  assert.ok(slots.every((s) => s.trigger === 'scheduled' && s.due_by));
}

// --- evaluate: current quarter covered by lab-1 ---
{
  const now = '2026-11-19T12:00:00.000Z';
  const r = evaluateCalendar({
    now,
    history: [
      {
        drill_id: 'lab-1',
        completed_at: '2026-11-19T09:30:00.000Z',
        mode: 'lab',
        trigger: 'scheduled',
        pass: true,
      },
    ],
  });
  assert.strictEqual(r.current_quarter_id, '2026-Q4');
  assert.strictEqual(r.quarter_satisfied, true);
  assert.strictEqual(r.overdue, false);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.next_due_quarter_id, '2027-Q1');
}

// --- evaluate: missing current quarter → overdue after soft due_by ---
{
  const now = '2026-12-20T00:00:00.000Z';
  const r = evaluateCalendar({
    now,
    history: [],
  });
  assert.strictEqual(r.current_quarter_id, '2026-Q4');
  assert.strictEqual(r.quarter_satisfied, false);
  assert.strictEqual(r.overdue, true);
  assert.strictEqual(r.pass, false);
}

// --- evaluate: early in quarter without completion → not overdue yet ---
{
  const now = '2026-10-05T00:00:00.000Z';
  const r = evaluateCalendar({
    now,
    history: [],
  });
  assert.strictEqual(r.current_quarter_id, '2026-Q4');
  assert.strictEqual(r.quarter_satisfied, false);
  assert.strictEqual(r.overdue, false);
  assert.strictEqual(r.pass, true);
  assert.ok(r.due_by);
}

// --- stack_change window ---
{
  const now = '2026-11-25T00:00:00.000Z';
  const r = evaluateCalendar({
    now,
    history: [
      {
        drill_id: 'lab-1',
        completed_at: '2026-11-05T09:30:00.000Z', // before stack change
        mode: 'lab',
        trigger: 'scheduled',
        pass: true,
      },
    ],
    stack_change_at: '2026-11-10T00:00:00.000Z',
  });
  assert.strictEqual(r.stack_change_overdue, true);
  assert.strictEqual(r.pass, false);
}

{
  const now = '2026-11-20T00:00:00.000Z';
  const r = evaluateCalendar({
    now,
    history: [
      {
        drill_id: 'lab-1',
        completed_at: '2026-11-19T09:30:00.000Z',
        mode: 'lab',
        trigger: 'stack_change',
        pass: true,
      },
    ],
    stack_change_at: '2026-11-10T00:00:00.000Z',
  });
  assert.strictEqual(r.stack_change_overdue, false);
  assert.strictEqual(r.pass, true);
}

// --- fail completions do not satisfy ---
{
  const now = '2026-11-19T12:00:00.000Z';
  const r = evaluateCalendar({
    now,
    history: [
      {
        drill_id: 'fail-1',
        completed_at: '2026-11-19T09:30:00.000Z',
        mode: 'lab',
        trigger: 'scheduled',
        pass: false,
      },
    ],
  });
  assert.strictEqual(r.quarter_satisfied, false);
}

// --- validation ---
throwsCode(() => evaluateCalendar({}), 'calendar_incomplete');
throwsCode(
  () =>
    evaluateCalendar({
      now: '2026-11-19T00:00:00.000Z',
      history: [{ drill_id: 'x', completed_at: 'bad', mode: 'lab', trigger: 'scheduled', pass: true }],
    }),
  'timestamp_invalid'
);
throwsCode(
  () =>
    evaluateCalendar({
      now: '2026-11-19T00:00:00.000Z',
      history: [
        {
          drill_id: 'x',
          completed_at: '2026-11-19T00:00:00.000Z',
          mode: 'weird',
          trigger: 'scheduled',
          pass: true,
        },
      ],
    }),
  'mode_invalid'
);

// --- committed calendar.json ---
{
  const cal = loadCalendar();
  assert.strictEqual(cal.policy.min_cadence, 'quarterly');
  assert.strictEqual(cal.policy.min_per_year, 4);
  assert.strictEqual(cal.policy.stack_change_window_days, 14);
  assert.ok(Array.isArray(cal.history));
  assert.ok(cal.history.some((h) => h.drill_id === 'lab-1' && h.pass === true));
  const r = evaluateCalendar({
    now: '2026-11-19T12:00:00.000Z',
    history: cal.history,
    stack_change_at: cal.stack_change_at || null,
  });
  assert.strictEqual(r.pass, true, `committed calendar must pass at seed time: ${JSON.stringify(r)}`);
  assert.ok(path.basename(CALENDAR_PATH) === 'calendar.json');
}

console.log('calendar.selftest: PASS');
