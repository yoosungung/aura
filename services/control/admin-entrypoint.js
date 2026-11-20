'use strict';

/**
 * Live entry for aura-control-admin Deployment.
 * Wires Pooler DSN → createAdminServer. Garage objectStore stub until provisioned.
 */

const { Pool } = require('pg');
const { createAdminServer } = require('./admin-server');

function buildPool() {
  const password =
    process.env.PGPASSWORD ||
    process.env.AURA_DATABASE_PASSWORD ||
    process.env.password;
  const host =
    process.env.AURA_DATABASE_HOST || 'aura-pg-pooler.aura.svc.cluster.local';
  const port = Number(process.env.AURA_DATABASE_PORT || 5432);
  const database = process.env.AURA_DATABASE_NAME || 'aura';
  const user = process.env.AURA_DATABASE_USER || 'aura';
  if (!password) {
    throw new Error('AURA_DATABASE_PASSWORD required');
  }
  return new Pool({
    host,
    port,
    database,
    user,
    password,
    max: 10,
    idleTimeoutMillis: 10_000,
  });
}

function buildObjectStore() {
  return {
    async getObject() {
      return null;
    },
    async presignPut({ bundle_uri }) {
      return {
        upload_url: `https://garage.pending.invalid/upload?uri=${encodeURIComponent(bundle_uri)}`,
        bundle_uri,
        headers: { 'content-type': 'application/octet-stream' },
      };
    },
  };
}

function buildAuthenticate() {
  const expected = process.env.AURA_ADMIN_BEARER || '';
  return (token) => {
    if (!token || !String(token).trim()) {
      return { ok: false, error: 'unauthorized' };
    }
    if (!expected) {
      return { ok: true, actor: 'ops' };
    }
    const raw = String(token).startsWith('Bearer ')
      ? String(token).slice(7)
      : String(token);
    if (raw !== expected && token !== `Bearer ${expected}`) {
      return { ok: false, error: 'unauthorized' };
    }
    return { ok: true, actor: 'ops' };
  };
}

function main() {
  const pool = buildPool();
  const port = Number(process.env.PORT || 8080);
  const server = createAdminServer({
    client: pool,
    objectStore: buildObjectStore(),
    adminTenantIds: process.env.AURA_ADMIN_TENANT_IDS || '',
    authenticate: buildAuthenticate(),
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('aura-control-admin listening on', port);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main, buildPool };
