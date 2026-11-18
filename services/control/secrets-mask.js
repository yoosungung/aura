'use strict';

/**
 * Secret / credential masking for logs & OTel (ARCHITECTURE §9.2).
 * Never emit plaintext secrets, tokens, or Authorization values.
 */

const SENSITIVE_KEY =
  /^(secrets?|password|passwd|token|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret)$/i;

const MASK = '***';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-clone value with sensitive keys replaced by MASK.
 * Arrays are walked; non-plain objects (Date, Buffer) copied by reference only
 * when not under a sensitive key (callers should not put secrets in those).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function maskSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = MASK;
    } else {
      out[key] = maskSecrets(raw);
    }
  }
  return out;
}

/**
 * Safe JSON string for log lines — always runs maskSecrets first.
 * @param {unknown} value
 * @returns {string}
 */
function maskSecretsForLog(value) {
  return JSON.stringify(maskSecrets(value));
}

module.exports = {
  MASK,
  SENSITIVE_KEY,
  maskSecrets,
  maskSecretsForLog,
};
