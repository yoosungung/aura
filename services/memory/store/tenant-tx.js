'use strict';

/**
 * Transaction-local tenant GUC for Pooler (ARCHITECTURE §1 #4 · §2.1).
 * Always: SELECT set_config('app.tenant_id', $1, true) — never false / session SET.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<unknown> }} client
 * @param {string} tenantId
 * @param {(client: typeof client) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTenantTx(client, tenantId, fn) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenant_id_required');
  }
  await client.query('BEGIN');
  try {
    // is_local=true → cleared on COMMIT/ROLLBACK (transaction pooling safe)
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback errors */
    }
    throw err;
  }
}

module.exports = { withTenantTx };
