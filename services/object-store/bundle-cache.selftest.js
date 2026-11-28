'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { sha256Prefixed } = require('./get-object');
const { createBundleCache, loadCachedBundle } = require('./bundle-cache');

const TENANT = '11111111-1111-4111-8111-111111111111';

function uriFor(name) {
  return `s3://aura-content/tenants/${TENANT}/bundles/mcp/demo/1/${name}`;
}

function opts(fetchImpl, cache) {
  return {
    tenantId: TENANT,
    endpoint: 'http://rustfs.aura.svc.cluster.local:9000',
    region: 'us-east-1',
    accessKeyId: 'lab-access',
    secretAccessKey: 'lab-secret-not-for-logs',
    fetchImpl,
    cache,
  };
}

async function main() {
  const body = Buffer.from('cached-bytes');
  const checksum = sha256Prefixed(body);
  const cache = createBundleCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 200, body };
  };
  const source = { bundle_uri: uriFor('mod.js'), checksum };
  const a = await loadCachedBundle(source, opts(fetchImpl, cache));
  const b = await loadCachedBundle(source, opts(fetchImpl, cache));
  assert.ok(a.equals(body));
  assert.ok(b.equals(a));
  assert.strictEqual(calls, 1);

  let badCalls = 0;
  const badCache = createBundleCache();
  await assert.rejects(
    () =>
      loadCachedBundle(source, opts(async () => {
        badCalls += 1;
        return { status: 200, body: Buffer.from('nope') };
      }, badCache)),
    /bundle_checksum_mismatch/,
  );
  await assert.rejects(
    () =>
      loadCachedBundle(source, opts(async () => {
        badCalls += 1;
        return { status: 200, body: Buffer.from('nope') };
      }, badCache)),
    /bundle_checksum_mismatch/,
  );
  assert.strictEqual(badCalls, 2);

  let miss = 0;
  await assert.rejects(
    () =>
      loadCachedBundle(
        { bundle_uri: `s3://aura-content/tenants/other/bundles/x`, checksum },
        opts(async () => {
          miss += 1;
          return { status: 200, body };
        }, createBundleCache()),
      ),
    /bundle_uri_tenant_mismatch/,
  );
  assert.strictEqual(miss, 0);

  let envCalls = 0;
  await assert.rejects(
    () =>
      loadCachedBundle(source, {
        tenantId: TENANT,
        cache: createBundleCache(),
        fetchImpl: async () => {
          envCalls += 1;
          return { status: 200, body };
        },
      }),
    /object_store_unconfigured/,
  );
  assert.strictEqual(envCalls, 0);

  const small = createBundleCache({ maxBytes: 8 });
  const first = Buffer.from('12345678');
  const second = Buffer.from('abcdefgh');
  const c1 = sha256Prefixed(first);
  const c2 = sha256Prefixed(second);
  let n = 0;
  const flip = async (url) => {
    n += 1;
    const which = String(url).endsWith('b.js') ? second : first;
    return { status: 200, body: which };
  };
  await loadCachedBundle(
    { bundle_uri: uriFor('a.js'), checksum: c1 },
    opts(flip, small),
  );
  await loadCachedBundle(
    { bundle_uri: uriFor('b.js'), checksum: c2 },
    opts(flip, small),
  );
  await loadCachedBundle(
    { bundle_uri: uriFor('a.js'), checksum: c1 },
    opts(flip, small),
  );
  assert.strictEqual(n, 3);

  assert.ok(crypto.createHash);
  console.log('bundle-cache.selftest: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
