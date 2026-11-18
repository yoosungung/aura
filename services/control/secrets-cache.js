'use strict';

/**
 * Short-lived in-process secrets cache (ARCHITECTURE §9.2).
 * TTL ≤ 60s; invalidate on aura.events.control.secrets.rotated.
 */

const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 60_000;
const ROTATE_SUBJECT = 'aura.events.control.secrets.rotated';

/**
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 */
function createSecretsCache(opts = {}) {
  const ttlMs = opts.ttlMs === undefined ? DEFAULT_TTL_MS : opts.ttlMs;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    const err = new Error('ttl_invalid');
    err.code = 'ttl_invalid';
    throw err;
  }
  if (ttlMs > MAX_TTL_MS) {
    const err = new Error(`ttl_exceeds_max:${ttlMs}`);
    err.code = 'ttl_exceeds_max';
    throw err;
  }
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const map = new Map();

  function get(key) {
    if (typeof key !== 'string' || !key) return undefined;
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value) {
    if (typeof key !== 'string' || !key) {
      const err = new Error('key_required');
      err.code = 'key_required';
      throw err;
    }
    map.set(key, { value, expiresAt: now() + ttlMs });
  }

  function invalidate(key) {
    if (typeof key === 'string' && key) map.delete(key);
  }

  function invalidateAll() {
    map.clear();
  }

  /**
   * Handle rotate/revoke event. Payload may scope by secrets_ref and/or tenant_id.
   * Missing scope → invalidateAll (safe default).
   *
   * @param {{ subject?: string, secrets_ref?: string|null, tenant_id?: string|null, key?: string|null }} evt
   */
  function handleRotatedEvent(evt) {
    if (!evt || typeof evt !== 'object') {
      invalidateAll();
      return { ok: true, action: 'invalidate_all', reason: 'evt_missing' };
    }
    if (evt.subject != null && evt.subject !== ROTATE_SUBJECT) {
      return { ok: false, action: 'ignored', reason: 'subject_mismatch' };
    }
    const key = evt.key || evt.secrets_ref;
    if (typeof key === 'string' && key) {
      invalidate(key);
      return { ok: true, action: 'invalidate_key', key };
    }
    if (typeof evt.tenant_id === 'string' && evt.tenant_id) {
      const prefix = `tenant:${evt.tenant_id}:`;
      for (const k of [...map.keys()]) {
        if (k.startsWith(prefix) || k.includes(`:${evt.tenant_id}:`)) {
          map.delete(k);
        }
      }
      return { ok: true, action: 'invalidate_tenant', tenant_id: evt.tenant_id };
    }
    invalidateAll();
    return { ok: true, action: 'invalidate_all', reason: 'unscoped' };
  }

  return {
    get,
    set,
    invalidate,
    invalidateAll,
    handleRotatedEvent,
    ttlMs,
    ROTATE_SUBJECT,
    size: () => map.size,
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  ROTATE_SUBJECT,
  createSecretsCache,
};
