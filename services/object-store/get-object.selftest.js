'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { getObject, sha256Prefixed } = require('./get-object');

const TENANT = '11111111-1111-4111-8111-111111111111';
const URI = `s3://aura-content/tenants/${TENANT}/bundles/mcp/demo/1/mod.js`;
const SECRET = 'lab-secret-not-for-logs';

function envOpts(extra) {
  return {
    endpoint: 'http://rustfs.aura.svc.cluster.local:9000',
    region: 'us-east-1',
    accessKeyId: 'lab-access',
    secretAccessKey: SECRET,
    tenantId: TENANT,
    ...extra,
  };
}

async function main() {
  const blob = Buffer.from('bundle-bytes');
  let calls = 0;
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const got = await getObject(
      URI,
      envOpts({
        fetchImpl: async (url, init) => {
          calls += 1;
          assert.ok(String(url).includes(`/tenants/${TENANT}/bundles/`));
          assert.ok(!String(url).includes(SECRET));
          const auth = init.headers.Authorization || '';
          assert.ok(auth.startsWith('AWS4-HMAC-SHA256'));
          assert.ok(!auth.includes(SECRET));
          return { status: 200, body: blob };
        },
      }),
    );
    assert.ok(got.equals(blob));
    assert.strictEqual(sha256Prefixed(got), sha256Prefixed(blob));
    assert.strictEqual(calls, 1);
    assert.ok(!logs.join('\n').includes(SECRET));
  } finally {
    console.log = orig;
  }

  await assert.rejects(
    () =>
      getObject(
        `s3://aura-content/tenants/other/bundles/mcp/demo/1/mod.js`,
        envOpts({
          fetchImpl: async () => {
            throw new Error('fetch_should_not_run');
          },
        }),
      ),
    /bundle_uri_tenant_mismatch/,
  );

  await assert.rejects(
    () =>
      getObject(`s3://aura-pg/tenants/${TENANT}/bundles/mcp/demo/1/mod.js`, envOpts({
        fetchImpl: async () => {
          throw new Error('fetch_should_not_run');
        },
      })),
    /bundle_uri_tenant_mismatch/,
  );

  await assert.rejects(
    () =>
      getObject(URI, {
        tenantId: TENANT,
        env: {},
        fetchImpl: async () => {
          throw new Error('fetch_should_not_run');
        },
      }),
    /object_store_unconfigured/,
  );

  const errLogs = [];
  const origErr = console.error;
  console.error = (...args) => errLogs.push(args.join(' '));
  try {
    await getObject(URI, envOpts({ fetchImpl: async () => ({ status: 200, body: blob }) }));
  } finally {
    console.error = origErr;
  }
  assert.ok(!errLogs.join('\n').includes(SECRET));
  assert.ok(!crypto.createHash('sha256').update(SECRET).digest('hex').includes(' '));

  console.log('get-object.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
