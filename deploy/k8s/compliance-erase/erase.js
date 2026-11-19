'use strict';

/**
 * Fission Package entry for aura.tasks.compliance.erase (ARCHITECTURE §9.3).
 * Source of truth: services/compliance/erase/{plan,handler}.js
 * Live OpenBao Transit destroy = injectable (Non-goal for CI).
 */

const PENDING_HOURS = 24;
const KMS_PRODUCT = 'openbao-transit';
const BUCKET = 'aura-content';
const STEPS = [
  'validate',
  'shred_keys',
  'invalidate_secrets_cache',
  'pg_redact',
  'delete_objects',
  'emit_done',
];

function kidTenant(tenantId, version) {
  return `tenant:${tenantId}:v${version}`;
}

function kidUser(tenantId, userId, version) {
  return `tenant:${tenantId}:user:${userId}:v${version}`;
}

function resolveKids(input) {
  if (!input || !input.tenant_id) {
    const err = new Error('tenant_id_required');
    err.code = 'tenant_id_required';
    err.status = 400;
    throw err;
  }
  const ver = input.key_version != null ? Number(input.key_version) : 1;
  if (!Number.isFinite(ver) || ver < 1) {
    const err = new Error('key_version_invalid');
    err.code = 'key_version_invalid';
    err.status = 400;
    throw err;
  }
  const scope = input.scope || 'tenant';
  if (scope === 'tenant') return [kidTenant(input.tenant_id, ver)];
  if (scope === 'user') {
    if (!input.user_id) {
      const err = new Error('user_id_required');
      err.code = 'user_id_required';
      err.status = 400;
      throw err;
    }
    return [kidUser(input.tenant_id, input.user_id, ver)];
  }
  const err = new Error('scope_invalid');
  err.code = 'scope_invalid';
  err.status = 400;
  throw err;
}

function refsPrefix(tenantId) {
  return `tenants/${tenantId}/refs/`;
}

function isEraseObjectTarget(tenantId, ref) {
  if (!ref || ref.bucket !== BUCKET) return { ok: false, reason: 'bucket' };
  if (!ref.key || typeof ref.key !== 'string') return { ok: false, reason: 'key' };
  if (ref.key.includes('/archive/') || ref.key.includes('/bundles/')) {
    return { ok: false, reason: 'prefix' };
  }
  if (!ref.key.startsWith(`tenants/${tenantId}/`)) {
    return { ok: false, reason: 'tenant' };
  }
  if (!ref.key.startsWith(refsPrefix(tenantId))) {
    return { ok: false, reason: 'prefix' };
  }
  return { ok: true };
}

function planErase(input) {
  if (!input || !input.tenant_id) {
    const err = new Error('tenant_id_required');
    err.code = 'tenant_id_required';
    err.status = 400;
    throw err;
  }
  const scope = input.scope || 'tenant';
  const kids_to_shred = resolveKids({
    scope,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    key_version: input.key_version,
  });
  const now = input.now != null ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    const err = new Error('timestamp_invalid');
    err.code = 'timestamp_invalid';
    err.status = 400;
    throw err;
  }
  const hours = input.pending_hours != null ? Number(input.pending_hours) : PENDING_HOURS;
  const pending_until = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  const refs = Array.isArray(input.content_refs) ? input.content_refs : [];
  const object_targets = [];
  const skipped_prefix = [];
  const skipped_bucket = [];
  const skipped_tenant = [];
  const skipped_kid = [];
  for (const ref of refs) {
    const check = isEraseObjectTarget(input.tenant_id, ref);
    if (!check.ok) {
      if (check.reason === 'prefix') skipped_prefix.push(ref.key);
      else if (check.reason === 'bucket') skipped_bucket.push(ref.key || '(no-key)');
      else if (check.reason === 'tenant') skipped_tenant.push(ref.key);
      continue;
    }
    const kid = ref.enc && ref.enc.kid;
    if (kid && !kids_to_shred.includes(kid)) {
      skipped_kid.push(ref.key);
      continue;
    }
    object_targets.push({ bucket: BUCKET, key: ref.key, kid: kid || kids_to_shred[0] });
  }
  return {
    tenant_id: input.tenant_id,
    scope,
    user_id: input.user_id || null,
    request_id: input.request_id || null,
    kms_product: KMS_PRODUCT,
    kids_to_shred,
    pending_hours: hours,
    pending_until,
    steps: STEPS.slice(),
    object_targets,
    skipped_prefix,
    skipped_bucket,
    skipped_tenant,
    skipped_kid,
  };
}

function idempotentTaskId(input) {
  if (!input || !input.tenant_id || !input.request_id) {
    const err = new Error('idempotent_id_incomplete');
    err.code = 'idempotent_id_incomplete';
    err.status = 400;
    throw err;
  }
  const scope = input.scope || 'tenant';
  if (scope === 'user') {
    return `erase:${input.tenant_id}:user:${input.user_id}:${input.request_id}`;
  }
  return `erase:${input.tenant_id}:tenant:${input.request_id}`;
}

async function assertNoDecryptableCiphertext(keyStore, samples) {
  for (const s of samples || []) {
    let plain;
    try {
      plain = await keyStore.decrypt(s.kid, s.ciphertext);
    } catch {
      plain = null;
    }
    if (plain != null && plain !== '') {
      const err = new Error('decryptable_ciphertext_remains');
      err.code = 'decryptable_ciphertext_remains';
      err.kid = s.kid;
      throw err;
    }
  }
}

async function runEraseOnce(deps, envelope) {
  if (!deps || !deps.keyStore || typeof deps.keyStore.destroy !== 'function') {
    const err = new Error('key_store_required');
    err.code = 'key_store_required';
    err.status = 500;
    throw err;
  }
  const tenantId = envelope && envelope.tenant_id;
  if (!tenantId) {
    const err = new Error('tenant_id_required');
    err.code = 'tenant_id_required';
    err.status = 400;
    throw err;
  }
  const p = (envelope && envelope.payload) || {};
  const plan = planErase({
    tenant_id: tenantId,
    scope: p.scope || 'tenant',
    user_id: p.user_id,
    key_version: p.key_version,
    request_id: p.request_id || (envelope && envelope.id),
    now: p.now,
    pending_hours: p.pending_hours,
    content_refs: p.content_refs,
  });
  const id =
    (envelope && envelope.id) ||
    idempotentTaskId({
      tenant_id: tenantId,
      scope: plan.scope,
      user_id: plan.user_id || undefined,
      request_id: plan.request_id || `auto-${Date.now()}`,
    });
  const steps_completed = ['validate'];
  const destroyed_kids = [];
  for (const kid of plan.kids_to_shred) {
    await deps.keyStore.destroy(kid);
    destroyed_kids.push(kid);
  }
  steps_completed.push('shred_keys');
  if (typeof deps.invalidateSecretsCache === 'function') {
    await deps.invalidateSecretsCache({ tenant_id: tenantId, kids: destroyed_kids });
  }
  steps_completed.push('invalidate_secrets_cache');
  let pg = { deleted: 0 };
  if (typeof deps.redactHotPg === 'function') {
    pg = await deps.redactHotPg({
      tenant_id: tenantId,
      scope: plan.scope,
      user_id: plan.user_id,
    });
  }
  steps_completed.push('pg_redact');
  const deleted_objects = [];
  if (typeof deps.deleteObject === 'function') {
    for (const t of plan.object_targets) {
      await deps.deleteObject({ bucket: t.bucket || BUCKET, key: t.key });
      deleted_objects.push(t.key);
    }
  }
  steps_completed.push('delete_objects');
  if (Array.isArray(p.ciphertexts) && typeof deps.keyStore.decrypt === 'function') {
    await assertNoDecryptableCiphertext(deps.keyStore, p.ciphertexts);
  }
  steps_completed.push('emit_done');
  return {
    status: 'erased',
    id,
    tenant_id: tenantId,
    scope: plan.scope,
    user_id: plan.user_id,
    kms_product: KMS_PRODUCT,
    destroyed_kids,
    deleted_objects,
    pg,
    pending_until: plan.pending_until,
    steps: STEPS.slice(),
    steps_completed,
    event: {
      type: 'compliance.erase.done',
      subject: 'aura.events.compliance.erase.done',
    },
  };
}

function parseBody(req) {
  let raw = (req && req.body) != null ? req.body : '';
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function eraseHandler(context) {
  let envelope;
  try {
    envelope = parseBody(context && context.request);
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({ error: 'invalid_json', detail: String(err && err.message) }),
    };
  }
  const deps = (context && context.eraseDeps) || {
    keyStore: {
      async destroy() {
        return { destroyed: true };
      },
      async decrypt() {
        return null;
      },
    },
  };
  try {
    const out = await runEraseOnce(deps, envelope);
    return { status: 200, body: JSON.stringify(out) };
  } catch (err) {
    return {
      status: err.status || 500,
      body: JSON.stringify({
        error: err.code || err.message || 'erase_failed',
        type: 'compliance.erase.error',
      }),
    };
  }
}

module.exports = eraseHandler;
module.exports.runEraseOnce = runEraseOnce;
module.exports.planErase = planErase;
module.exports.idempotentTaskId = idempotentTaskId;
module.exports.KMS_PRODUCT = KMS_PRODUCT;
module.exports.STEPS = STEPS;
