'use strict';

/**
 * PG PITR recurring drill calendar — policy + compliance (M5 · §9.6).
 * Min cadence: quarterly (≥1 pass/quarter). Stack-change follow-up ≤14d.
 * Non-goals: calendar UI · live CNPG cron · auto-apply restore.
 */

const fs = require('fs');
const path = require('path');

const MIN_CADENCE = 'quarterly';
const MIN_PER_YEAR = 4;
const STACK_CHANGE_WINDOW_DAYS = 14;
const MODES = new Set(['lab', 'cluster']);
const TRIGGERS = new Set(['scheduled', 'stack_change', 'incident_followup']);

const CALENDAR_PATH = path.join(__dirname, 'calendar.json');

function parseTs(label, value) {
  if (value == null || value === '') {
    const err = new Error(`${label}_required`);
    err.code = 'calendar_incomplete';
    err.status = 400;
    throw err;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    const err = new Error(`${label}_invalid`);
    err.code = 'timestamp_invalid';
    err.status = 400;
    throw err;
  }
  return ms;
}

function quarterOf(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : parseTs('date', isoOrMs);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const q = Math.floor(month / 3) + 1;
  return { year, q };
}

function quarterId(q) {
  return `${q.year}-Q${q.q}`;
}

function quarterBounds(year, q) {
  if (q < 1 || q > 4) {
    const err = new Error('quarter_invalid');
    err.code = 'quarter_invalid';
    throw err;
  }
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  let endExclusive;
  if (q === 4) {
    endExclusive = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));
  } else {
    endExclusive = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0, 0));
  }
  // Soft deadline: first day of the quarter's last month (still inside the quarter).
  const due_by = new Date(Date.UTC(year, startMonth + 2, 1, 0, 0, 0, 0));
  return {
    start: start.toISOString(),
    endExclusive: endExclusive.toISOString(),
    due_by: due_by.toISOString(),
  };
}

function nextQuarter(q) {
  if (q.q === 4) return { year: q.year + 1, q: 1 };
  return { year: q.year, q: q.q + 1 };
}

function plannedSlots(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1970) {
    const err = new Error('year_invalid');
    err.code = 'year_invalid';
    throw err;
  }
  return [1, 2, 3, 4].map((q) => {
    const b = quarterBounds(y, q);
    return {
      quarter_id: `${y}-Q${q}`,
      trigger: 'scheduled',
      window_start: b.start,
      due_by: b.due_by,
      mode_preferred: 'cluster',
      mode_acceptable: ['cluster', 'lab'],
    };
  });
}

function normalizeHistory(history) {
  if (history == null) return [];
  if (!Array.isArray(history)) {
    const err = new Error('history_invalid');
    err.code = 'history_invalid';
    throw err;
  }
  return history.map((h, i) => {
    if (!h || !h.drill_id || h.pass == null) {
      const err = new Error(`history[${i}]_incomplete`);
      err.code = 'calendar_incomplete';
      throw err;
    }
    if (!MODES.has(h.mode)) {
      const err = new Error('mode_invalid');
      err.code = 'mode_invalid';
      throw err;
    }
    if (!TRIGGERS.has(h.trigger)) {
      const err = new Error('trigger_invalid');
      err.code = 'trigger_invalid';
      throw err;
    }
    const completed_ms = parseTs('completed_at', h.completed_at);
    return { ...h, completed_ms, pass: Boolean(h.pass) };
  });
}

/**
 * @param {{
 *   now: string,
 *   history?: Array<{
 *     drill_id: string,
 *     completed_at: string,
 *     mode: 'lab'|'cluster',
 *     trigger: 'scheduled'|'stack_change'|'incident_followup',
 *     pass: boolean,
 *   }>,
 *   stack_change_at?: string|null,
 * }} input
 */
function evaluateCalendar(input) {
  if (!input || !input.now) {
    const err = new Error('calendar_incomplete');
    err.code = 'calendar_incomplete';
    err.status = 400;
    throw err;
  }
  const nowMs = parseTs('now', input.now);
  const q = quarterOf(nowMs);
  const bounds = quarterBounds(q.year, q.q);
  const dueByMs = Date.parse(bounds.due_by);
  const windowStartMs = Date.parse(bounds.start);
  const windowEndMs = Date.parse(bounds.endExclusive);

  const history = normalizeHistory(input.history);
  const inQuarter = history.filter(
    (h) =>
      h.pass &&
      h.completed_ms >= windowStartMs &&
      h.completed_ms < windowEndMs
  );
  const quarter_satisfied = inQuarter.length >= 1;
  const overdue = !quarter_satisfied && nowMs > dueByMs;

  let stack_change_overdue = false;
  let stack_change_due_by = null;
  if (input.stack_change_at) {
    const changeMs = parseTs('stack_change_at', input.stack_change_at);
    const windowMs = STACK_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const due = changeMs + windowMs;
    stack_change_due_by = new Date(due).toISOString();
    const covered = history.some(
      (h) => h.pass && h.completed_ms >= changeMs && h.completed_ms <= due
    );
    if (!covered && nowMs > due) {
      stack_change_overdue = true;
    }
  }

  const nq = quarter_satisfied ? nextQuarter(q) : q;
  const nextBounds = quarterBounds(nq.year, nq.q);

  return {
    current_quarter_id: quarterId(q),
    due_by: bounds.due_by,
    quarter_satisfied,
    overdue,
    stack_change_overdue,
    stack_change_due_by,
    next_due_quarter_id: quarterId(nq),
    next_due_by: nextBounds.due_by,
    min_cadence: MIN_CADENCE,
    min_per_year: MIN_PER_YEAR,
    completions_this_quarter: inQuarter.map((h) => h.drill_id),
    pass: !overdue && !stack_change_overdue,
  };
}

function loadCalendar(filePath) {
  const p = filePath || CALENDAR_PATH;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!raw || typeof raw !== 'object' || !raw.policy) {
    const err = new Error('calendar_invalid');
    err.code = 'calendar_invalid';
    throw err;
  }
  return raw;
}

module.exports = {
  MIN_CADENCE,
  MIN_PER_YEAR,
  STACK_CHANGE_WINDOW_DAYS,
  CALENDAR_PATH,
  quarterOf,
  quarterId,
  quarterBounds,
  nextQuarter,
  plannedSlots,
  evaluateCalendar,
  loadCalendar,
};
