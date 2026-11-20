'use strict';

/**
 * aura.rpc.control.resolve bridge handler (M3 Warm Core RR).
 * Contract: ARCHITECTURE §3.3 · deploy/docs/control-resolve-bridge.md
 * Wire helpers: ./resolve.js — Non-goals: live Pooler client · HTTP admin · NATS SDK wiring.
 */

const {
  validateResolveRequest,
  buildResolveResponse,
} = require('./resolve');

const SUBJECT = 'aura.rpc.control.resolve';
/** NATS queue-group lives on aura-nats-rpc-bridge (shared). */
const QUEUE_GROUP = 'aura-rpc-bridge';

/** Fixture rows for mode=stub (no PG). */
const STUB_SOURCE = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tenant_id: '11111111-1111-1111-1111-111111111111',
  kind: 'agent',
  name: 'demo',
  version: '1.0.0',
  entrypoint: 'main:factory',
  bundle_uri: 's3://aura-content/tenants/11111111-1111-1111-1111-111111111111/bundles/demo/1.0.0',
  checksum: 'sha256:deadbeef',
  sig_uri: null,
  config: { timeout_seconds: 30, llm: { model: 'a', temp: 0.2 } },
  status: 'active',
  created_at: '2026-11-18T00:00:00.000Z',
};

const STUB_USER = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  tenant_id: '11111111-1111-1111-1111-111111111111',
  source_meta_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  principal_id: 'user-1',
  config: { llm: { model: 'b' }, flag: true },
  secrets_ref: 'k8s:secret/aura-demo/user-1',
  updated_at: '2026-11-18T00:00:00.000Z',
};

/**
 * @param {object} req resolve request body
 * @param {{ lookup?: (req: object) => Promise<{source: object|null, user: object|null}>, mode?: string }} [opts]
 */
async function handleResolve(req, opts = {}) {
  const v = validateResolveRequest(req);
  if (!v.ok) {
    return {
      type: 'control.resolve.error',
      error: v.error,
      subject: SUBJECT,
      ok: false,
    };
  }

  let source;
  let user;
  if (typeof opts.lookup === 'function') {
    const rows = await opts.lookup(req);
    source = rows && rows.source;
    user = rows && rows.user;
  } else {
    // stub: only match the fixture identifiers; otherwise source_not_active
    const match =
      req.tenant_id === STUB_SOURCE.tenant_id &&
      req.kind === STUB_SOURCE.kind &&
      req.name === STUB_SOURCE.name &&
      req.version === STUB_SOURCE.version;
    source = match ? STUB_SOURCE : null;
    user =
      match && req.principal.id === STUB_USER.principal_id ? STUB_USER : null;
  }

  const body = buildResolveResponse({ source, user });
  return {
    ...body,
    subject: SUBJECT,
    deploy_class: 'sync',
    mode: typeof opts.lookup === 'function' ? 'injectable' : 'stub',
    ok: body.type === 'control.resolve.done',
  };
}

module.exports = {
  SUBJECT,
  QUEUE_GROUP,
  STUB_SOURCE,
  STUB_USER,
  handleResolve,
};
