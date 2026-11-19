'use strict';

/**
 * PG PITR drill measurement — RPO/RTO from recovered data + full restore path.
 * Budgets: ARCHITECTURE §9.6 / M1 draft — RPO ≤ 5m · RTO ≤ 1h (M4 drill confirms).
 * Non-goals: live CNPG Multi-AZ apply · Barman Cloud credentials · M5 calendar.
 */

const fs = require('fs');
const path = require('path');

const RPO_BUDGET_MS = 5 * 60 * 1000;
const RTO_BUDGET_MS = 60 * 60 * 1000;

/** Ordered recovery phases (provision optional; headline RTO = restore→dsn_cutover). */
const PHASES = ['provision', 'restore', 'replay', 'verify', 'dsn_cutover'];

const RECORD_PATH = path.join(__dirname, 'drill-1.record.json');

function parseTs(label, value) {
  if (value == null || value === '') {
    const err = new Error(`${label}_required`);
    err.code = 'drill_incomplete';
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

/**
 * @param {{ rpo_ms: number, rto_ms: number, rpo_budget_ms?: number, rto_budget_ms?: number }} input
 */
function evaluateBudgets(input) {
  const rpoBudget = input.rpo_budget_ms != null ? input.rpo_budget_ms : RPO_BUDGET_MS;
  const rtoBudget = input.rto_budget_ms != null ? input.rto_budget_ms : RTO_BUDGET_MS;
  const rpo_pass = Number(input.rpo_ms) <= rpoBudget;
  const rto_pass = Number(input.rto_ms) <= rtoBudget;
  return { rpo_pass, rto_pass, pass: rpo_pass && rto_pass };
}

/**
 * Measure RPO from recovered usable data; RTO from restore_start → dsn_cutover_end.
 *
 * @param {{
 *   drill_id: string,
 *   mode: 'lab'|'cluster',
 *   incident_at: string,
 *   newest_verified_at: string,
 *   phases: {
 *     provision_start?: string,
 *     provision_end?: string,
 *     restore_start: string,
 *     replay_end?: string,
 *     verify_end: string,
 *     dsn_cutover_end: string,
 *   },
 *   notes?: string,
 * }} input
 */
function measureDrill(input) {
  if (!input || !input.drill_id || !input.mode) {
    const err = new Error('drill_incomplete');
    err.code = 'drill_incomplete';
    err.status = 400;
    throw err;
  }
  if (input.mode !== 'lab' && input.mode !== 'cluster') {
    const err = new Error('mode_invalid');
    err.code = 'mode_invalid';
    err.status = 400;
    throw err;
  }

  const phases = input.phases || {};
  const incident = parseTs('incident_at', input.incident_at);
  const verified = parseTs('newest_verified_at', input.newest_verified_at);
  const restoreStart = parseTs('restore_start', phases.restore_start);
  const verifyEnd = parseTs('verify_end', phases.verify_end);
  const cutoverEnd = parseTs('dsn_cutover_end', phases.dsn_cutover_end);

  if (verified > incident) {
    const err = new Error('verified_after_incident');
    err.code = 'verified_after_incident';
    err.status = 400;
    throw err;
  }
  if (cutoverEnd < restoreStart) {
    const err = new Error('cutover_before_restore');
    err.code = 'cutover_before_restore';
    err.status = 400;
    throw err;
  }

  const rpo_ms = incident - verified;
  const rto_ms = cutoverEnd - restoreStart;

  const phase_ms = {};
  if (phases.provision_start && phases.provision_end) {
    phase_ms.provision =
      parseTs('provision_end', phases.provision_end) -
      parseTs('provision_start', phases.provision_start);
  }
  if (phases.replay_end) {
    phase_ms.restore =
      parseTs('replay_end', phases.replay_end) - restoreStart;
    phase_ms.replay = 0; // folded into restore→replay_end window above
    phase_ms.verify = verifyEnd - parseTs('replay_end', phases.replay_end);
  } else {
    phase_ms.restore = verifyEnd - restoreStart;
    phase_ms.verify = 0;
  }
  phase_ms.dsn_cutover = cutoverEnd - verifyEnd;

  const budgets = evaluateBudgets({ rpo_ms, rto_ms });

  return {
    drill_id: input.drill_id,
    mode: input.mode,
    rpo_ms,
    rto_ms,
    rpo_budget_ms: RPO_BUDGET_MS,
    rto_budget_ms: RTO_BUDGET_MS,
    rpo_pass: budgets.rpo_pass,
    rto_pass: budgets.rto_pass,
    pass: budgets.pass,
    phase_ms,
    notes: input.notes || null,
  };
}

function loadDrillRecord(filePath) {
  const p = filePath || RECORD_PATH;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!raw || typeof raw !== 'object') {
    const err = new Error('record_invalid');
    err.code = 'record_invalid';
    throw err;
  }
  return raw;
}

module.exports = {
  RPO_BUDGET_MS,
  RTO_BUDGET_MS,
  PHASES,
  RECORD_PATH,
  evaluateBudgets,
  measureDrill,
  loadDrillRecord,
};
