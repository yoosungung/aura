'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createAdminHandlers, CONTENT_IMMUTABLE } = require('./admin-http');
const { createPoolerLookup } = require('./pooler-lookup');
const { handleResolve } = require('./bridge');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function createMemoryStore() {
  const sources = [];
  const overlays = [];
  const audits = [];
  const tenants = [];
  let guc = null;

  const client = {
    sources,
    overlays,
    audits,
    tenants,
    async query(text, params = []) {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        if (text === 'ROLLBACK' || text === 'COMMIT') guc = null;
        return { rows: [] };
      }
      if (/set_config\('app\.tenant_id'/.test(text)) {
        guc = params[0];
        return { rows: [{ set_config: params[0] }] };
      }
      if (/FROM tenant_meta ORDER BY display_name/.test(text)) {
        return {
          rows: [...tenants]
            .sort((a, b) =>
              String(a.display_name).localeCompare(String(b.display_name)) ||
              String(a.id).localeCompare(String(b.id))
            )
            .map((t) => ({ id: t.id, display_name: t.display_name })),
        };
      }
      if (/INSERT INTO tenant_meta/.test(text)) {
        const id = params[0];
        const display_name = params[1];
        const existing = tenants.find((t) => t.id === id);
        const now = new Date().toISOString();
        if (existing) {
          existing.display_name = display_name;
          existing.updated_at = now;
          return {
            rows: [
              {
                id: existing.id,
                display_name: existing.display_name,
                created_at: existing.created_at,
                updated_at: existing.updated_at,
              },
            ],
          };
        }
        const row = { id, display_name, created_at: now, updated_at: now };
        tenants.push(row);
        return { rows: [row] };
      }
      if (/UPDATE tenant_meta/.test(text)) {
        const row = tenants.find((t) => t.id === params[0]);
        if (!row) return { rows: [] };
        row.display_name = params[1];
        row.updated_at = new Date().toISOString();
        return {
          rows: [
            {
              id: row.id,
              display_name: row.display_name,
              created_at: row.created_at,
              updated_at: row.updated_at,
            },
          ],
        };
      }
      if (/SELECT DISTINCT tenant_id/.test(text)) {
        const ids = [...new Set(sources.map((s) => s.tenant_id))];
        return { rows: ids.map((tenant_id) => ({ tenant_id })) };
      }
      if (/INSERT INTO source_meta/.test(text)) {
        const row = {
          id: params[0],
          tenant_id: params[1],
          kind: params[2],
          name: params[3],
          version: params[4],
          entrypoint: params[5],
          function: params[6],
          bundle_uri: params[7],
          checksum: params[8],
          sig_uri: params[9],
          config: JSON.parse(params[10]),
          runtime: params[11],
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        if (
          sources.some(
            (s) =>
              s.tenant_id === row.tenant_id &&
              s.kind === row.kind &&
              s.name === row.name &&
              s.version === row.version
          )
        ) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        sources.push(row);
        return { rows: [row] };
      }
      if (/INSERT INTO control_audit/.test(text)) {
        audits.push({
          tenant_id: params[0],
          actor: params[1],
          action: params[2],
          resource_type: params[3],
          resource_id: params[4],
          reason: params[5],
        });
        return { rows: [] };
      }
      if (/FROM source_meta WHERE tenant_id = \$1::uuid\s+ORDER BY kind/.test(text)) {
        assert.strictEqual(guc, params[0]);
        return { rows: sources.filter((s) => s.tenant_id === params[0]) };
      }
      if (/FROM source_meta\s+WHERE tenant_id = \$1::uuid AND kind = \$2 AND name = \$3/.test(text)) {
        return {
          rows: sources.filter(
            (s) => s.tenant_id === params[0] && s.kind === params[1] && s.name === params[2]
          ),
        };
      }
      if (
        /SELECT id, kind, name, version, runtime, bundle_uri, checksum, status\s+FROM source_meta/.test(
          text
        ) ||
        /SELECT id, status, bundle_uri, checksum(?:, runtime, entrypoint(?:, function)?)?\s+FROM source_meta/.test(
          text
        ) ||
        /SELECT id, status FROM source_meta/.test(text) ||
        /SELECT id FROM source_meta WHERE tenant_id/.test(text)
      ) {
        const row = sources.find((s) => s.tenant_id === params[0] && s.id === params[1]);
        return { rows: row ? [row] : [] };
      }
      if (/UPDATE source_meta SET status = 'active'/.test(text)) {
        const row = sources.find(
          (s) => s.tenant_id === params[0] && s.id === params[1] && s.status === 'pending'
        );
        if (!row) return { rows: [] };
        row.status = 'active';
        return { rows: [{ id: row.id, status: 'active' }] };
      }
      if (/UPDATE source_meta SET status = 'retired'/.test(text)) {
        const row = sources.find(
          (s) => s.tenant_id === params[0] && s.id === params[1] && s.status === 'active'
        );
        if (!row) return { rows: [] };
        row.status = 'retired';
        return { rows: [{ id: row.id, status: 'retired' }] };
      }
      if (/FROM source_meta\s+WHERE tenant_id = \$1::uuid\s+AND kind = \$2 AND name = \$3 AND version = \$4\s+AND status = 'active'/.test(text)) {
        const row = sources.find(
          (s) =>
            s.tenant_id === params[0] &&
            s.kind === params[1] &&
            s.name === params[2] &&
            s.version === params[3] &&
            s.status === 'active'
        );
        return { rows: row ? [row] : [] };
      }
      if (/INSERT INTO user_meta/.test(text)) {
        const existing = overlays.find(
          (o) => o.source_meta_id === params[1] && o.principal_id === params[2]
        );
        const row = {
          id: existing ? existing.id : crypto.randomUUID(),
          tenant_id: params[0],
          source_meta_id: params[1],
          principal_id: params[2],
          config: JSON.parse(params[3]),
          secrets_ref: params[4],
          updated_at: new Date().toISOString(),
        };
        if (existing) {
          Object.assign(existing, row);
          return { rows: [existing] };
        }
        overlays.push(row);
        return { rows: [row] };
      }
      if (/FROM user_meta\s+WHERE tenant_id = \$1::uuid AND source_meta_id = \$2::uuid\s+ORDER BY/.test(text)) {
        return {
          rows: overlays.filter(
            (o) => o.tenant_id === params[0] && o.source_meta_id === params[1]
          ),
        };
      }
      if (/FROM user_meta\s+WHERE tenant_id = \$1::uuid\s+AND source_meta_id = \$2::uuid\s+AND principal_id = \$3/.test(text)) {
        const row = overlays.find(
          (o) =>
            o.tenant_id === params[0] &&
            o.source_meta_id === params[1] &&
            o.principal_id === params[2]
        );
        return { rows: row ? [row] : [] };
      }
      if (/DELETE FROM user_meta/.test(text)) {
        const idx = overlays.findIndex(
          (o) =>
            o.tenant_id === params[0] &&
            o.source_meta_id === params[1] &&
            o.principal_id === params[2]
        );
        if (idx < 0) return { rows: [] };
        const [removed] = overlays.splice(idx, 1);
        return { rows: [{ id: removed.id }] };
      }
      if (/FROM control_audit/.test(text)) {
        assert.strictEqual(guc, params[0]);
        const actionFilter = params[3] || null;
        let rows = audits
          .filter((a) => a.tenant_id === params[0])
          .filter((a) => {
            if (!actionFilter) return true;
            return a.action === actionFilter || a.action.startsWith(actionFilter + '.');
          })
          .map((a, i) => ({
            id: a.id || `audit-${i}`,
            actor: a.actor,
            action: a.action,
            resource_type: a.resource_type,
            resource_id: a.resource_id,
            reason: a.reason,
            at: a.at || new Date().toISOString(),
          }))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)));
        const cursor = params[1];
        const limit = Number(params[2] || 50);
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor);
          rows = idx >= 0 ? rows.slice(idx + 1) : rows;
        }
        return { rows: rows.slice(0, limit) };
      }
      throw new Error(`unexpected: ${text}`);
    },
  };

  return client;
}

async function main() {
  assert.ok(CONTENT_IMMUTABLE.has('bundle_uri'));
  assert.ok(CONTENT_IMMUTABLE.has('checksum'));

  const store = createMemoryStore();
  const blob = Buffer.from('bundle-bytes-v1');
  const goodChecksum = 'sha256:' + crypto.createHash('sha256').update(blob).digest('hex');
  const objects = new Map();

  const { createMemoryKv, createTenantRateLimiter } = require('../gateway/rate-limit');
  const quotaLimiter = createTenantRateLimiter({ kv: createMemoryKv() });

  const { dispatch } = createAdminHandlers({
    client: store,
    quotaLimiter,
    authenticate: (t) => (t === 'Bearer ops-token' ? { ok: true, actor: 'ops@aura' } : { ok: false }),
    objectStore: {
      async getObject(uri) {
        return objects.get(uri) || null;
      },
      async presignPut({ bundle_uri }) {
        return {
          upload_url: 'https://rustfs.test/put',
          bundle_uri,
          headers: {},
        };
      },
    },
  });

  const unauth = await dispatch({ method: 'GET', path: '/v1/tenants' });
  assert.strictEqual(unauth.status, 401);

  const health = await dispatch({
    method: 'GET',
    path: '/healthz',
    authorization: 'Bearer ops-token',
  });
  assert.strictEqual(health.status, 200);

  const tenants0 = await dispatch({
    method: 'GET',
    path: '/v1/tenants',
    authorization: 'Bearer ops-token',
  });
  assert.strictEqual(tenants0.status, 200);
  assert.ok(Array.isArray(tenants0.body.tenants));

  const createdAuto = await dispatch({
    method: 'POST',
    path: '/v1/tenants',
    authorization: 'Bearer ops-token',
    body: { display_name: 'Auto Lab' },
  });
  assert.strictEqual(createdAuto.status, 200);
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      createdAuto.body.tenant.id
    ),
    'auto-generated tenant UUID'
  );
  assert.strictEqual(createdAuto.body.tenant.display_name, 'Auto Lab');

  const upsertT = await dispatch({
    method: 'POST',
    path: '/v1/tenants',
    authorization: 'Bearer ops-token',
    body: { id: TENANT_A, display_name: 'Acme Lab' },
  });
  assert.strictEqual(upsertT.status, 200);
  assert.strictEqual(upsertT.body.tenant.display_name, 'Acme Lab');
  const upsertB = await dispatch({
    method: 'POST',
    path: '/v1/tenants',
    authorization: 'Bearer ops-token',
    body: { id: TENANT_B, display_name: 'Beta' },
  });
  assert.strictEqual(upsertB.status, 200);
  const tenantsNamed = await dispatch({
    method: 'GET',
    path: '/v1/tenants',
    authorization: 'Bearer ops-token',
  });
  const acme = tenantsNamed.body.tenants.find((t) => t.id === TENANT_A);
  assert.ok(acme && acme.display_name === 'Acme Lab');
  assert.ok(tenantsNamed.body.tenants.some((t) => t.id === TENANT_B));

  const noTenant = await dispatch({
    method: 'POST',
    path: '/v1/sources',
    authorization: 'Bearer ops-token',
    headers: {},
    body: {},
  });
  assert.strictEqual(noTenant.status, 400);

  const hdr = { 'x-aura-tenant-id': TENANT_A };
  const auth = { authorization: 'Bearer ops-token', headers: hdr };

  const presign = await dispatch({
    ...auth,
    method: 'POST',
    path: '/v1/bundles/presign',
    body: { kind: 'agent', name: 'demo', version: '1.0.0' },
  });
  assert.strictEqual(presign.status, 200);
  assert.ok(presign.body.bundle_uri.includes(TENANT_A));

  const runtimeInCfg = await dispatch({
    ...auth,
    method: 'POST',
    path: '/v1/sources',
    body: {
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      entrypoint: 'main:factory',
      bundle_uri: presign.body.bundle_uri,
      checksum: goodChecksum,
      config: { runtime: 'python' },
    },
  });
  assert.strictEqual(runtimeInCfg.status, 400);

  const created = await dispatch({
    ...auth,
    method: 'POST',
    path: '/v1/sources',
    body: {
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      entrypoint: 'main:factory',
      bundle_uri: presign.body.bundle_uri,
      checksum: goodChecksum,
      runtime: 'nodejs',
      config: { timeout_seconds: 30 },
    },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.source.status, 'pending');
  const sourceId = created.body.source.id;

  const dup = await dispatch({
    ...auth,
    method: 'POST',
    path: '/v1/sources',
    body: {
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      entrypoint: 'main:factory',
      bundle_uri: presign.body.bundle_uri,
      checksum: goodChecksum,
    },
  });
  assert.strictEqual(dup.status, 409);

  const badActivate = await dispatch({
    ...auth,
    method: 'POST',
    path: `/v1/sources/${sourceId}/activate`,
  });
  assert.strictEqual(badActivate.status, 422);
  assert.strictEqual(badActivate.body.error, 'bundle_missing');

  objects.set(presign.body.bundle_uri, Buffer.from('tampered'));
  const mismatch = await dispatch({
    ...auth,
    method: 'POST',
    path: `/v1/sources/${sourceId}/activate`,
  });
  assert.strictEqual(mismatch.status, 422);
  assert.strictEqual(mismatch.body.error, 'checksum_mismatch');
  assert.strictEqual(store.sources[0].status, 'pending');

  objects.set(presign.body.bundle_uri, blob);
  const activated = await dispatch({
    ...auth,
    method: 'POST',
    path: `/v1/sources/${sourceId}/activate`,
  });
  assert.strictEqual(activated.status, 200);
  assert.strictEqual(activated.body.source.status, 'active');
  assert.ok(store.audits.some((a) => a.action === 'source.activate'));

  const overlay = await dispatch({
    ...auth,
    method: 'PUT',
    path: `/v1/sources/${sourceId}/overlays/user-1`,
    body: { config: { llm: { model: 'b' } }, secrets_ref: 'k8s:secret/demo' },
  });
  assert.strictEqual(overlay.status, 200);

  const plaintext = await dispatch({
    ...auth,
    method: 'PUT',
    path: `/v1/sources/${sourceId}/overlays/user-2`,
    body: { secrets: { api_key: 'x' } },
  });
  assert.strictEqual(plaintext.status, 400);

  const lookup = createPoolerLookup(store);
  const resolved = await handleResolve(
    {
      tenant_id: TENANT_A,
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      principal: { id: 'user-1', tenant_id: TENANT_A },
    },
    { lookup }
  );
  assert.strictEqual(resolved.type, 'control.resolve.done');
  assert.strictEqual(resolved.source.id, sourceId);
  assert.strictEqual(resolved.secrets_ref, 'k8s:secret/demo');

  const otherTenant = await handleResolve(
    {
      tenant_id: TENANT_B,
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      principal: { id: 'user-1', tenant_id: TENANT_B },
    },
    { lookup }
  );
  assert.strictEqual(otherTenant.type, 'control.resolve.error');

  const delNoReason = await dispatch({
    ...auth,
    method: 'DELETE',
    path: `/v1/sources/${sourceId}/overlays/user-1`,
    body: {},
  });
  assert.strictEqual(delNoReason.status, 400);

  const deleted = await dispatch({
    ...auth,
    method: 'DELETE',
    path: `/v1/sources/${sourceId}/overlays/user-1`,
    body: { reason: 'cleanup' },
  });
  assert.strictEqual(deleted.status, 200);
  assert.ok(store.audits.some((a) => a.action === 'overlay.delete' && a.reason === 'cleanup'));

  const retired = await dispatch({
    ...auth,
    method: 'POST',
    path: `/v1/sources/${sourceId}/retire`,
    body: { reason: 'superseded' },
  });
  assert.strictEqual(retired.status, 200);
  assert.strictEqual(store.sources[0].status, 'retired');

  const tenants1 = await dispatch({
    method: 'GET',
    path: '/v1/tenants',
    authorization: 'Bearer ops-token',
  });
  assert.ok(tenants1.body.tenants.some((t) => t.id === TENANT_A));
  assert.ok(tenants1.body.tenants.some((t) => t.id === TENANT_B));

  const qGet = await dispatch({
    ...auth,
    method: 'GET',
    path: `/v1/quotas/${TENANT_A}`,
  });
  assert.strictEqual(qGet.status, 200);
  assert.strictEqual(qGet.body.tenant_id, TENANT_A);
  const qReset = await dispatch({
    ...auth,
    method: 'POST',
    path: `/v1/quotas/${TENANT_A}/reset`,
    body: { reason: 'ops clear' },
  });
  assert.strictEqual(qReset.status, 200);
  assert.ok(qReset.body.reset);
  assert.ok(store.audits.some((a) => a.action === 'quota.reset'));

  const audit = await dispatch({
    ...auth,
    method: 'GET',
    path: '/v1/audit',
    query: { limit: '10' },
  });
  assert.strictEqual(audit.status, 200, 'GET /v1/audit must succeed');
  assert.ok(Array.isArray(audit.body.items), 'audit.items array');
  assert.ok(audit.body.items.length >= 1, 'audit has entries after activate/retire/overlay');
  assert.ok(audit.body.items.every((i) => i.action && i.actor), 'audit rows shaped');

  const auditFiltered = await dispatch({
    ...auth,
    method: 'GET',
    path: '/v1/audit',
    query: { limit: '50', action: 'source.retire' },
  });
  assert.strictEqual(auditFiltered.status, 200);
  assert.ok(
    auditFiltered.body.items.length >= 1 &&
      auditFiltered.body.items.every((i) => i.action === 'source.retire'),
    'audit action filter exact'
  );
  const auditPrefix = await dispatch({
    ...auth,
    method: 'GET',
    path: '/v1/audit',
    query: { action: 'overlay' },
  });
  assert.ok(
    auditPrefix.body.items.every((i) => i.action === 'overlay' || i.action.startsWith('overlay.')),
    'audit action filter prefix'
  );

  const { customBundleUri, customChecksum } = require('./admin-http');
  const badFn = await dispatch({
    ...auth,
    method: 'POST',
    path: '/v1/sources',
    body: {
      kind: 'agent',
      name: 'custom-demo',
      version: '1.0.0',
      function: 'wrong-prefix',
      runtime: 'custom',
    },
  });
  assert.strictEqual(badFn.status, 400);
  assert.strictEqual(badFn.body.error, 'function_prefix_invalid');

  const customCreated = await dispatch({
    ...auth,
    method: 'POST',
    path: '/v1/sources',
    body: {
      kind: 'agent',
      name: 'custom-demo',
      version: '1.0.0',
      function: 'aura-agent-invoke-demo',
      runtime: 'custom',
      config: { region: 'lab' },
    },
  });
  assert.strictEqual(customCreated.status, 201);
  assert.strictEqual(customCreated.body.source.runtime, 'custom');
  assert.strictEqual(customCreated.body.source.function, 'aura-agent-invoke-demo');
  assert.strictEqual(customCreated.body.source.entrypoint, null);
  assert.strictEqual(
    customCreated.body.source.bundle_uri,
    customBundleUri('aura-agent-invoke-demo')
  );
  assert.strictEqual(
    customCreated.body.source.checksum,
    customChecksum('aura-agent-invoke-demo')
  );
  const customId = customCreated.body.source.id;
  const customActivated = await dispatch({
    ...auth,
    method: 'POST',
    path: `/v1/sources/${customId}/activate`,
  });
  assert.strictEqual(customActivated.status, 200);
  assert.strictEqual(customActivated.body.source.status, 'active');

  const customDl = await dispatch({
    ...auth,
    method: 'GET',
    path: `/v1/sources/${customId}/bundle`,
  });
  assert.strictEqual(customDl.status, 400);
  assert.strictEqual(customDl.body.error, 'bundle_not_downloadable');

  const zipDl = await dispatch({
    ...auth,
    method: 'GET',
    path: `/v1/sources/${sourceId}/bundle`,
  });
  assert.strictEqual(zipDl.status, 200);
  assert.strictEqual(zipDl.body.checksum, goodChecksum);
  assert.strictEqual(
    Buffer.from(zipDl.body.content_base64, 'base64').toString('utf8'),
    blob.toString('utf8')
  );
  assert.ok(store.audits.some((a) => a.action === 'source.bundle.download'));

  console.log('admin-http.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
