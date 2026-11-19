'use strict';

/**
 * compliance.erase planner — content_ref + crypto-shredding (ARCHITECTURE §9.3).
 * KMS = OpenBao Transit · kid = tenant:{id}:vN | tenant:{id}:user:{uid}:vN
 * Object delete = aura-content refs/ only (defense in depth after key shred).
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

/**
 * @param {{
 *   scope: 'tenant'|'user',
 *   tenant_id: string,
 *   user_id?: string,
 *   key_version?: number,
 * }} input
 */
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
  if (scope === 'tenant') {
    return [kidTenant(input.tenant_id, ver)];
  }
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
  // archive/bundles: never DeleteObject here (crypto-shred covers undecryptability)
  if (ref.key.includes('/archive/') || ref.key.includes('/bundles/')) {
    return { ok: false, reason: 'prefix' };
  }
  if (!ref.key.startsWith(`tenants/${tenantId}/`)) {
    return { ok: false, reason: 'tenant' };
  }
  // Object delete defense-in-depth: refs/ only
  if (!ref.key.startsWith(refsPrefix(tenantId))) {
    return { ok: false, reason: 'prefix' };
  }
  return { ok: true };
}

/**
 * Plan erase steps + object targets. Actual shred/delete is handler.
 *
 * @param {{
 *   tenant_id: string,
 *   scope?: 'tenant'|'user',
 *   user_id?: string,
 *   key_version?: number,
 *   request_id?: string,
 *   now?: string|Date,
 *   pending_hours?: number,
 *   content_refs?: Array<{
 *     bucket: string,
 *     key: string,
 *     enc?: { alg?: string, kid?: string },
 *   }>,
 * }} input
 */
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
    object_targets.push({
      bucket: BUCKET,
      key: ref.key,
      kid: kid || kids_to_shred[0],
    });
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

/**
 * Idempotent envelope id.
 * @param {{ tenant_id: string, scope: string, user_id?: string, request_id: string }} input
 */
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

module.exports = {
  PENDING_HOURS,
  KMS_PRODUCT,
  BUCKET,
  STEPS,
  kidTenant,
  kidUser,
  resolveKids,
  refsPrefix,
  isEraseObjectTarget,
  planErase,
  idempotentTaskId,
};
