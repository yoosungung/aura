'use strict';

/**
 * Pooler SELECT for aura.rpc.control.resolve (M6).
 * Contract: ARCHITECTURE §2.1 · §6.1 · deploy/docs/admin-ui.md
 */

const { withTenantTx } = require('./tenant-tx');

/**
 * @param {{ query: Function }} client
 * @returns {(req: object) => Promise<{source: object|null, user: object|null}>}
 */
function createPoolerLookup(client) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('client_required');
  }

  return async function lookup(req) {
    const tenantId = req.tenant_id;
    return withTenantTx(client, tenantId, async (c) => {
      const srcRes = await c.query(
        `SELECT id, tenant_id, kind, name, version, entrypoint, function, bundle_uri,
                checksum, sig_uri, config, runtime, status, created_at
           FROM source_meta
          WHERE tenant_id = $1::uuid
            AND kind = $2 AND name = $3 AND version = $4
            AND status = 'active'
          LIMIT 1`,
        [tenantId, req.kind, req.name, req.version]
      );
      const source = srcRes.rows && srcRes.rows[0] ? mapSource(srcRes.rows[0]) : null;
      if (!source) {
        return { source: null, user: null };
      }

      const principalId = req.principal && req.principal.id;
      if (!principalId) {
        return { source, user: null };
      }

      const userRes = await c.query(
        `SELECT id, tenant_id, source_meta_id, principal_id, config, secrets_ref, updated_at
           FROM user_meta
          WHERE tenant_id = $1::uuid
            AND source_meta_id = $2::uuid
            AND principal_id = $3
          LIMIT 1`,
        [tenantId, source.id, principalId]
      );
      const user = userRes.rows && userRes.rows[0] ? mapUser(userRes.rows[0]) : null;
      return { source, user };
    });
  };
}

function mapSource(row) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    kind: row.kind,
    name: row.name,
    version: row.version,
    entrypoint: row.entrypoint == null ? null : row.entrypoint,
    function: row.function == null ? null : row.function,
    bundle_uri: row.bundle_uri,
    checksum: row.checksum,
    sig_uri: row.sig_uri == null ? null : row.sig_uri,
    config: row.config || {},
    runtime: row.runtime || 'nodejs',
    status: row.status,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

function mapUser(row) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    source_meta_id: String(row.source_meta_id),
    principal_id: row.principal_id,
    config: row.config || {},
    secrets_ref: row.secrets_ref == null ? null : row.secrets_ref,
    updated_at:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

module.exports = {
  createPoolerLookup,
  mapSource,
  mapUser,
};
