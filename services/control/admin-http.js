'use strict';

/**
 * svc-control admin HTTP handlers (M6 ops-only).
 * Contract: deploy/docs/admin-ui-mvp.md · ARCHITECTURE §6.1.1
 */

const crypto = require('crypto');
const { withTenantTx } = require('./tenant-tx');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_IMMUTABLE = new Set([
  'entrypoint',
  'bundle_uri',
  'checksum',
  'sig_uri',
  'config',
  'runtime',
  'kind',
  'name',
  'version',
]);

/**
 * @param {object} opts
 * @param {{ query: Function }} opts.client
 * @param {{ getObject: (uri: string) => Promise<Buffer|null>, presignPut?: Function }} [opts.objectStore]
 * @param {string} [opts.adminTenantIds] CSV from AURA_ADMIN_TENANT_IDS
 * @param {(token: string|null) => {ok:boolean, actor?:string, error?:string}} [opts.authenticate]
 */
function createAdminHandlers(opts = {}) {
  const client = opts.client;
  if (!client || typeof client.query !== 'function') {
    throw new Error('client_required');
  }
  const objectStore = opts.objectStore || {
    async getObject() {
      return null;
    },
    async presignPut({ bundle_uri }) {
      return {
        upload_url: `https://example.invalid/upload?uri=${encodeURIComponent(bundle_uri)}`,
        bundle_uri,
        headers: { 'content-type': 'application/octet-stream' },
      };
    },
  };
  const staticTenants = parseTenantCsv(opts.adminTenantIds || process.env.AURA_ADMIN_TENANT_IDS || '');
  const authenticate =
    opts.authenticate ||
    ((token) =>
      token && token.length > 0
        ? { ok: true, actor: 'ops' }
        : { ok: false, error: 'unauthorized' });

  async function dispatch(req) {
    const auth = authenticate(req.authorization || null);
    if (!auth.ok) {
      return { status: 401, body: { error: auth.error || 'unauthorized' } };
    }
    const actor = auth.actor || 'ops';
    const method = (req.method || 'GET').toUpperCase();
    const path = normalizePath(req.path || '/');

    if (method === 'GET' && path === '/healthz') {
      return { status: 200, body: { ok: true } };
    }

    if (method === 'GET' && path === '/v1/tenants') {
      return listTenants(client, staticTenants);
    }

    const tenantId = req.headers && req.headers['x-aura-tenant-id'];
    if (!tenantId || !UUID_RE.test(tenantId)) {
      return { status: 400, body: { error: 'tenant_id_required' } };
    }

    if (method === 'POST' && path === '/v1/bundles/presign') {
      return presign(objectStore, tenantId, req.body || {});
    }
    if (method === 'POST' && path === '/v1/sources') {
      return createSource(client, tenantId, actor, req.body || {});
    }
    if (method === 'GET' && path === '/v1/sources') {
      return listSources(client, tenantId);
    }

    const kindName = path.match(/^\/v1\/sources\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && kindName) {
      return listSourceVersions(client, tenantId, decodeURIComponent(kindName[1]), decodeURIComponent(kindName[2]));
    }

    const activate = path.match(/^\/v1\/sources\/([^/]+)\/activate$/);
    if (method === 'POST' && activate) {
      return activateSource(client, objectStore, tenantId, actor, activate[1]);
    }
    const retire = path.match(/^\/v1\/sources\/([^/]+)\/retire$/);
    if (method === 'POST' && retire) {
      return retireSource(client, tenantId, actor, retire[1], req.body || {});
    }

    const overlaysList = path.match(/^\/v1\/sources\/([^/]+)\/overlays$/);
    if (method === 'GET' && overlaysList) {
      return listOverlays(client, tenantId, overlaysList[1]);
    }
    const overlay = path.match(/^\/v1\/sources\/([^/]+)\/overlays\/([^/]+)$/);
    if (overlay) {
      const sourceId = overlay[1];
      const principalId = decodeURIComponent(overlay[2]);
      if (method === 'PUT') {
        return upsertOverlay(client, tenantId, actor, sourceId, principalId, req.body || {});
      }
      if (method === 'DELETE') {
        return deleteOverlay(client, tenantId, actor, sourceId, principalId, req.body || req.query || {});
      }
    }

    return { status: 404, body: { error: 'not_found' } };
  }

  return { dispatch, CONTENT_IMMUTABLE };
}

function normalizePath(p) {
  if (!p) return '/';
  const q = p.indexOf('?');
  const base = q >= 0 ? p.slice(0, q) : p;
  return base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
}

function parseTenantCsv(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
}

async function listTenants(client, staticTenants) {
  const res = await client.query(
    `SELECT DISTINCT tenant_id::text AS tenant_id FROM source_meta ORDER BY 1`
  );
  const fromDb = (res.rows || []).map((r) => r.tenant_id);
  const set = new Set([...staticTenants, ...fromDb]);
  return { status: 200, body: { tenants: [...set].sort() } };
}

async function presign(objectStore, tenantId, body) {
  const kind = body.kind;
  const name = body.name;
  const version = body.version;
  if (!kind || !name || !version) {
    return { status: 400, body: { error: 'kind_name_version_required' } };
  }
  const key = `tenants/${tenantId}/bundles/${kind}/${name}/${version}`;
  const bundle_uri = body.bundle_uri || `s3://aura-content/${key}`;
  if (!bundle_uri.includes(`/tenants/${tenantId}/bundles/`)) {
    return { status: 400, body: { error: 'bundle_uri_tenant_mismatch' } };
  }
  const signed = await objectStore.presignPut({
    tenant_id: tenantId,
    bundle_uri,
    key,
  });
  return {
    status: 200,
    body: {
      upload_url: signed.upload_url,
      bundle_uri: signed.bundle_uri || bundle_uri,
      headers: signed.headers || {},
    },
  };
}

function rejectRuntimeInConfig(config) {
  if (config && typeof config === 'object' && !Array.isArray(config) && 'runtime' in config) {
    return true;
  }
  return false;
}

async function createSource(client, tenantId, actor, body) {
  const required = ['kind', 'name', 'version', 'entrypoint', 'bundle_uri', 'checksum'];
  for (const k of required) {
    if (!body[k]) return { status: 400, body: { error: `${k}_required` } };
  }
  if (!['agent', 'mcp'].includes(body.kind)) {
    return { status: 400, body: { error: 'kind_invalid' } };
  }
  const runtime = body.runtime || 'nodejs';
  if (!['nodejs', 'python', 'custom'].includes(runtime)) {
    return { status: 400, body: { error: 'runtime_invalid' } };
  }
  const config = body.config && typeof body.config === 'object' ? body.config : {};
  if (rejectRuntimeInConfig(config)) {
    return { status: 400, body: { error: 'runtime_in_config_forbidden' } };
  }
  if (!String(body.checksum).startsWith('sha256:')) {
    return { status: 400, body: { error: 'checksum_sha256_required' } };
  }

  try {
    const row = await withTenantTx(client, tenantId, async (c) => {
      const id = body.id || crypto.randomUUID();
      const ins = await c.query(
        `INSERT INTO source_meta
           (id, tenant_id, kind, name, version, entrypoint, bundle_uri, checksum, sig_uri, config, runtime, status)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'pending')
         RETURNING id, tenant_id, kind, name, version, entrypoint, bundle_uri, checksum, sig_uri, config, runtime, status, created_at`,
        [
          id,
          tenantId,
          body.kind,
          body.name,
          body.version,
          body.entrypoint,
          body.bundle_uri,
          body.checksum,
          body.sig_uri || null,
          JSON.stringify(config),
          runtime,
        ]
      );
      await insertAudit(c, {
        tenantId,
        actor,
        action: 'source.create',
        resource_type: 'source_meta',
        resource_id: id,
        reason: body.reason || null,
      });
      return ins.rows[0];
    });
    return { status: 201, body: { source: row } };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: 409, body: { error: 'version_exists' } };
    }
    throw err;
  }
}

async function listSources(client, tenantId) {
  const rows = await withTenantTx(client, tenantId, async (c) => {
    const res = await c.query(
      `SELECT id, tenant_id, kind, name, version, runtime, status, created_at
         FROM source_meta WHERE tenant_id = $1::uuid
         ORDER BY kind, name, created_at DESC`,
      [tenantId]
    );
    return res.rows;
  });
  return { status: 200, body: { sources: rows } };
}

async function listSourceVersions(client, tenantId, kind, name) {
  const rows = await withTenantTx(client, tenantId, async (c) => {
    const res = await c.query(
      `SELECT id, tenant_id, kind, name, version, entrypoint, bundle_uri, checksum, runtime, status, created_at
         FROM source_meta
        WHERE tenant_id = $1::uuid AND kind = $2 AND name = $3
        ORDER BY created_at DESC`,
      [tenantId, kind, name]
    );
    return res.rows;
  });
  return { status: 200, body: { sources: rows } };
}

async function activateSource(client, objectStore, tenantId, actor, sourceId) {
  return withTenantTx(client, tenantId, async (c) => {
    const cur = await c.query(
      `SELECT id, status, bundle_uri, checksum FROM source_meta
        WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [tenantId, sourceId]
    );
    const row = cur.rows && cur.rows[0];
    if (!row) return { status: 404, body: { error: 'source_not_found' } };
    if (row.status !== 'pending') {
      return { status: 409, body: { error: 'status_not_pending' } };
    }

    const buf = await objectStore.getObject(row.bundle_uri);
    if (!buf) {
      return { status: 422, body: { error: 'bundle_missing' } };
    }
    const digest = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== row.checksum) {
      return { status: 422, body: { error: 'checksum_mismatch', expected: row.checksum, actual: digest } };
    }

    const upd = await c.query(
      `UPDATE source_meta SET status = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'
        RETURNING id, status`,
      [tenantId, sourceId]
    );
    if (!upd.rows || !upd.rows[0]) {
      return { status: 409, body: { error: 'status_not_pending' } };
    }
    await insertAudit(c, {
      tenantId,
      actor,
      action: 'source.activate',
      resource_type: 'source_meta',
      resource_id: sourceId,
      reason: null,
    });
    return { status: 200, body: { source: { id: sourceId, status: 'active' } } };
  });
}

async function retireSource(client, tenantId, actor, sourceId, body) {
  const reason = body && body.reason;
  if (!reason || !String(reason).trim()) {
    return { status: 400, body: { error: 'reason_required' } };
  }
  return withTenantTx(client, tenantId, async (c) => {
    const cur = await c.query(
      `SELECT id, status FROM source_meta
        WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [tenantId, sourceId]
    );
    const row = cur.rows && cur.rows[0];
    if (!row) return { status: 404, body: { error: 'source_not_found' } };
    if (row.status !== 'active') {
      return { status: 409, body: { error: 'status_not_active' } };
    }
    await c.query(
      `UPDATE source_meta SET status = 'retired'
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'`,
      [tenantId, sourceId]
    );
    await insertAudit(c, {
      tenantId,
      actor,
      action: 'source.retire',
      resource_type: 'source_meta',
      resource_id: sourceId,
      reason: String(reason),
    });
    return { status: 200, body: { source: { id: sourceId, status: 'retired' } } };
  });
}

async function listOverlays(client, tenantId, sourceId) {
  const rows = await withTenantTx(client, tenantId, async (c) => {
    const res = await c.query(
      `SELECT id, principal_id, config, secrets_ref, updated_at
         FROM user_meta
        WHERE tenant_id = $1::uuid AND source_meta_id = $2::uuid
        ORDER BY principal_id`,
      [tenantId, sourceId]
    );
    return res.rows;
  });
  return { status: 200, body: { overlays: rows } };
}

async function upsertOverlay(client, tenantId, actor, sourceId, principalId, body) {
  const config = body.config && typeof body.config === 'object' ? body.config : {};
  if (rejectRuntimeInConfig(config)) {
    return { status: 400, body: { error: 'runtime_in_config_forbidden' } };
  }
  if (body.secrets != null || body.secret_value != null) {
    return { status: 400, body: { error: 'plaintext_secrets_forbidden' } };
  }
  const secrets_ref = body.secrets_ref != null ? String(body.secrets_ref) : null;

  const row = await withTenantTx(client, tenantId, async (c) => {
    const src = await c.query(
      `SELECT id FROM source_meta WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [tenantId, sourceId]
    );
    if (!src.rows || !src.rows[0]) {
      const err = new Error('source_not_found');
      err.code = 'SOURCE_NOT_FOUND';
      throw err;
    }
    const upsert = await c.query(
      `INSERT INTO user_meta (tenant_id, source_meta_id, principal_id, config, secrets_ref)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)
       ON CONFLICT (source_meta_id, principal_id)
       DO UPDATE SET config = EXCLUDED.config,
                     secrets_ref = EXCLUDED.secrets_ref,
                     updated_at = now()
       RETURNING id, principal_id, config, secrets_ref, updated_at`,
      [tenantId, sourceId, principalId, JSON.stringify(config), secrets_ref]
    );
    await insertAudit(c, {
      tenantId,
      actor,
      action: 'overlay.upsert',
      resource_type: 'user_meta',
      resource_id: `${sourceId}:${principalId}`,
      reason: body.reason || null,
    });
    return upsert.rows[0];
  }).catch((err) => {
    if (err.code === 'SOURCE_NOT_FOUND') {
      return { __http: { status: 404, body: { error: 'source_not_found' } } };
    }
    throw err;
  });
  if (row && row.__http) return row.__http;
  return { status: 200, body: { overlay: row } };
}

async function deleteOverlay(client, tenantId, actor, sourceId, principalId, body) {
  const reason = body && body.reason;
  if (!reason || !String(reason).trim()) {
    return { status: 400, body: { error: 'reason_required' } };
  }
  return withTenantTx(client, tenantId, async (c) => {
    const del = await c.query(
      `DELETE FROM user_meta
        WHERE tenant_id = $1::uuid AND source_meta_id = $2::uuid AND principal_id = $3
        RETURNING id`,
      [tenantId, sourceId, principalId]
    );
    if (!del.rows || !del.rows[0]) {
      return { status: 404, body: { error: 'overlay_not_found' } };
    }
    await insertAudit(c, {
      tenantId,
      actor,
      action: 'overlay.delete',
      resource_type: 'user_meta',
      resource_id: `${sourceId}:${principalId}`,
      reason: String(reason),
    });
    return { status: 200, body: { deleted: true } };
  });
}

async function insertAudit(c, { tenantId, actor, action, resource_type, resource_id, reason }) {
  await c.query(
    `INSERT INTO control_audit (tenant_id, actor, action, resource_type, resource_id, reason)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [tenantId, actor, action, resource_type, resource_id, reason]
  );
}

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /unique|duplicate/i.test(String(err.message || '')));
}

module.exports = {
  createAdminHandlers,
  CONTENT_IMMUTABLE,
  UUID_RE,
};
