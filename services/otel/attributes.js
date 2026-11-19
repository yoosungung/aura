'use strict';

/**
 * OTel attribute allowlist + secret sanitization (ARCHITECTURE §9.2 · M4).
 * Reuses services/control maskSecrets — never emit plaintext secrets on spans.
 */

const { maskSecrets } = require('../control/secrets-mask');

/** Required correlation keys on every Aura span (M4 success). */
const REQUIRED_CONTEXT_KEYS = Object.freeze([
  'aura.tenant_id',
  'aura.session_id',
  'aura.run_id',
]);

/**
 * Allowlisted attribute keys. Anything else is dropped before export.
 * Query parameter attributes and connection strings are intentionally absent.
 */
const ALLOWED_ATTR_KEYS = new Set([
  ...REQUIRED_CONTEXT_KEYS,
  'faas.name',
  'aura.function.name',
  'aura.rpc.subject',
  'messaging.system.name',
  'messaging.operation.name',
  'messaging.destination.name',
  'db.system.name',
  'db.operation.name',
  'db.query.summary',
  'db.query.text',
  'server.address',
  'server.port',
  'error.type',
]);

const SENSITIVE_VALUE =
  /\b(postgres(ql)?:\/\/[^\s"']+|Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{8,})\b/i;

/**
 * Keep only allowlisted keys; run maskSecrets first (defense in depth).
 * @param {Record<string, unknown>} attrs
 * @returns {Record<string, string|number|boolean>}
 */
function sanitizeAttributes(attrs) {
  if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return {};
  }
  const masked = maskSecrets(attrs);
  const out = {};
  for (const [key, raw] of Object.entries(masked)) {
    if (!ALLOWED_ATTR_KEYS.has(key)) continue;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'object') continue; // only scalar attrs on the wire
    out[key] = raw;
  }
  return out;
}

/**
 * Sanitize then require tenant/session/run; reject residual plaintext patterns
 * or non-allowlisted keys that slipped past (caller passed unsanitized).
 * @param {Record<string, unknown>} attrs
 * @returns {Record<string, string|number|boolean>}
 */
function assertSafeAttributes(attrs) {
  const clean = sanitizeAttributes(attrs);
  for (const key of REQUIRED_CONTEXT_KEYS) {
    if (clean[key] === undefined || clean[key] === null || clean[key] === '') {
      const err = new Error(`missing_context:${key}`);
      err.code = 'missing_context';
      throw err;
    }
  }
  // If caller passed raw object with disallowed keys still present on input
  // after sanitize they are gone; detect unsanitized use via original keys.
  if (attrs && typeof attrs === 'object') {
    for (const key of Object.keys(attrs)) {
      if (!ALLOWED_ATTR_KEYS.has(key)) {
        const err = new Error(`disallowed_attr:${key}`);
        err.code = 'disallowed_attr';
        throw err;
      }
    }
  }
  const blob = JSON.stringify(clean);
  if (SENSITIVE_VALUE.test(blob)) {
    const err = new Error('plaintext_secret_in_attributes');
    err.code = 'plaintext';
    throw err;
  }
  return clean;
}

module.exports = {
  ALLOWED_ATTR_KEYS,
  REQUIRED_CONTEXT_KEYS,
  sanitizeAttributes,
  assertSafeAttributes,
};
