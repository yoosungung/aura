'use strict';

/**
 * compliance.erase handler — crypto-shred DEKs then hot PG redact + refs DeleteObject.
 * ARCHITECTURE §9.3. Non-goals: live OpenBao apply · full-tenant wipe CI · PITR.
 */

const {
  planErase,
  idempotentTaskId,
  STEPS,
  KMS_PRODUCT,
  BUCKET,
} = require('./plan');

/**
 * After shred, every sample ciphertext must fail decrypt (null/throw).
 * @param {{ decrypt: Function }} keyStore
 * @param {Array<{ kid: string, ciphertext: string }>} samples
 */
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

/**
 * @param {{
 *   keyStore: { destroy: Function, has?: Function, decrypt?: Function },
 *   invalidateSecretsCache?: Function,
 *   redactHotPg?: Function,
 *   deleteObject?: Function,
 * }} deps
 * @param {object} envelope
 */
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

  const steps_completed = [];
  steps_completed.push('validate');

  // 1) crypto-shred — destroy DEKs first (SoR for undecryptable ciphertext)
  const destroyed_kids = [];
  for (const kid of plan.kids_to_shred) {
    await deps.keyStore.destroy(kid);
    destroyed_kids.push(kid);
  }
  steps_completed.push('shred_keys');

  // 2) invalidate short-lived process / secrets cache for shredded kids
  if (typeof deps.invalidateSecretsCache === 'function') {
    await deps.invalidateSecretsCache({
      tenant_id: tenantId,
      kids: destroyed_kids,
    });
  }
  steps_completed.push('invalidate_secrets_cache');

  // 3) hot PG redact / row delete (injectable; live SQL = later)
  let pg = { deleted: 0 };
  if (typeof deps.redactHotPg === 'function') {
    pg = await deps.redactHotPg({
      tenant_id: tenantId,
      scope: plan.scope,
      user_id: plan.user_id,
    });
  }
  steps_completed.push('pg_redact');

  // 4) defense-in-depth DeleteObject on refs/ targets only
  const deleted_objects = [];
  if (typeof deps.deleteObject === 'function') {
    for (const t of plan.object_targets) {
      await deps.deleteObject({ bucket: t.bucket || BUCKET, key: t.key });
      deleted_objects.push(t.key);
    }
  }
  steps_completed.push('delete_objects');

  // Prove no decryptable ciphertext remains when samples provided
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

module.exports = {
  runEraseOnce,
  assertNoDecryptableCiphertext,
};
