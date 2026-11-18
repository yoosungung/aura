'use strict';

const assert = require('assert');
const {
  mergeConfigs,
  buildResolveResponse,
  validateResolveRequest,
} = require('./resolve');

function main() {
  // merge: 1-depth section, user wins; source keys preserved under same section
  assert.deepStrictEqual(
    mergeConfigs(
      { timeout_seconds: 30, llm: { model: 'a', temp: 0.2 } },
      { llm: { model: 'b' }, flag: true },
    ),
    { timeout_seconds: 30, llm: { model: 'b', temp: 0.2 }, flag: true },
  );
  assert.deepStrictEqual(mergeConfigs({ a: 1 }, null), { a: 1 });
  assert.deepStrictEqual(mergeConfigs({ a: 1 }, {}), { a: 1 });

  const reqOk = validateResolveRequest({
    tenant_id: '11111111-1111-1111-1111-111111111111',
    kind: 'agent',
    name: 'demo',
    version: '1.0.0',
    principal: {
      id: 'user-1',
      tenant_id: '11111111-1111-1111-1111-111111111111',
    },
  });
  assert.strictEqual(reqOk.ok, true);

  assert.strictEqual(
    validateResolveRequest({
      tenant_id: '11111111-1111-1111-1111-111111111111',
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      principal: { id: 'user-1', tenant_id: 'other-tenant' },
    }).ok,
    false,
  );
  assert.strictEqual(
    validateResolveRequest({
      kind: 'agent',
      name: 'demo',
      version: '1.0.0',
      principal: { id: 'u', tenant_id: 't' },
    }).ok,
    false,
  );
  assert.strictEqual(
    validateResolveRequest({
      tenant_id: 't',
      kind: 'bot',
      name: 'demo',
      version: '1',
      principal: { id: 'u', tenant_id: 't' },
    }).ok,
    false,
  );

  const source = {
    id: '22222222-2222-2222-2222-222222222222',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    kind: 'agent',
    name: 'demo',
    version: '1.0.0',
    entrypoint: 'main:factory',
    bundle_uri: 's3://aura-content/tenants/11111111-1111-1111-1111-111111111111/bundles/agent/demo/1.0.0/bundle.zip',
    checksum: 'sha256:abc',
    sig_uri: null,
    config: { llm: { model: 'base' }, timeout_seconds: 10 },
    status: 'active',
    created_at: '2026-11-19T00:00:00Z',
  };
  const user = {
    id: '33333333-3333-3333-3333-333333333333',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    source_meta_id: source.id,
    principal_id: 'user-1',
    config: { llm: { model: 'override' } },
    secrets_ref: 'k8s:secret/aura-user-demo',
    updated_at: '2026-11-19T01:00:00Z',
  };

  const done = buildResolveResponse({ source, user });
  assert.strictEqual(done.type, 'control.resolve.done');
  assert.strictEqual(done.source.name, 'demo');
  assert.strictEqual(done.user.principal_id, 'user-1');
  assert.deepStrictEqual(done.cfg, {
    llm: { model: 'override' },
    timeout_seconds: 10,
  });
  assert.strictEqual(done.secrets_ref, 'k8s:secret/aura-user-demo');
  assert.ok(!('secrets' in done), 'plaintext secrets must not appear');
  assert.ok(!JSON.stringify(done).includes('sk-'), 'no secret material');

  const retired = buildResolveResponse({
    source: { ...source, status: 'retired' },
    user: null,
  });
  assert.strictEqual(retired.type, 'control.resolve.error');
  assert.strictEqual(retired.error, 'source_not_active');

  const noUser = buildResolveResponse({ source, user: null });
  assert.strictEqual(noUser.type, 'control.resolve.done');
  assert.strictEqual(noUser.user, null);
  assert.deepStrictEqual(noUser.cfg, source.config);
  assert.strictEqual(noUser.secrets_ref, null);

  console.log('resolve.selftest: PASS');
}

main();
