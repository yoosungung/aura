'use strict';

/**
 * agent_checkpoints Pooler writer/resume (M3.5 · Zero Direct Write exception).
 * Only table: agent_checkpoints. set_config(..., true) only.
 */

const ALLOWED_KINDS = new Set(['turn', 'tool', 'final']);

/**
 * @param {object} opts
 * @param {Function} opts.query — async (text, params) => { rows }
 */
function createCheckpointStore(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const query = o.query;
  if (typeof query !== 'function') {
    const err = new Error('query_required');
    err.code = 'query_required';
    throw err;
  }

  async function withTenant(tenantId, fn) {
    if (!tenantId || typeof tenantId !== 'string') {
      const err = new Error('tenant_id_required');
      throw err;
    }
    await query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn();
  }

  return {
    /**
     * Append checkpoint row.
     */
    async write(row) {
      const r = row && typeof row === 'object' ? row : {};
      if (!ALLOWED_KINDS.has(r.kind)) {
        const err = new Error('kind_invalid');
        err.code = 'kind_invalid';
        throw err;
      }
      if (r.state && r.state.secrets) {
        const err = new Error('secrets_plaintext_forbidden');
        throw err;
      }
      return withTenant(r.tenant_id, async () => {
        const res = await query(
          `INSERT INTO agent_checkpoints
            (tenant_id, run_id, session_id, principal_id, seq, parent_id, kind, state, content_ref)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           RETURNING id, seq`,
          [
            r.tenant_id,
            r.run_id,
            r.session_id || '',
            r.principal_id,
            r.seq,
            r.parent_id || null,
            r.kind,
            JSON.stringify(r.state || {}),
            r.content_ref || null,
          ],
        );
        return res && res.rows && res.rows[0];
      });
    },

    /**
     * Load latest checkpoint for run (resume).
     */
    async loadLatest(tenantId, runId) {
      return withTenant(tenantId, async () => {
        const res = await query(
          `SELECT id, run_id, session_id, seq, kind, state, content_ref, parent_id
             FROM agent_checkpoints
            WHERE run_id = $1
            ORDER BY seq DESC
            LIMIT 1`,
          [runId],
        );
        return res && res.rows && res.rows[0] ? res.rows[0] : null;
      });
    },
  };
}

/**
 * Build pg Pool query adapter. Lazy-require('pg') so handler shell stays clean.
 * @param {{ connectionString: string }} opts
 */
function createPoolerQuery(opts) {
  const o = opts || {};
  if (!o.connectionString) {
    const err = new Error('connection_string_required');
    throw err;
  }
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: o.connectionString });
  return {
    pool,
    async query(text, params) {
      return pool.query(text, params);
    },
  };
}

module.exports = {
  ALLOWED_KINDS,
  createCheckpointStore,
  createPoolerQuery,
};
