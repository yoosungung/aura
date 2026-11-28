'use strict';

/**
 * NATS client mTLS option builder (ARCHITECTURE §9.2).
 * Production connections must present client cert + trust CA; plaintext-only forbidden.
 */

/**
 * @param {{ ca?: string|Buffer, cert?: string|Buffer, key?: string|Buffer, requireMtls?: boolean }} opts
 * @returns {{ tls: { ca: string|Buffer, cert: string|Buffer, key: string|Buffer } }}
 */
function buildNatsTlsOptions(opts = {}) {
  const requireMtls = opts.requireMtls !== false;
  const { ca, cert, key } = opts;
  const missing = [];
  if (!ca) missing.push('ca');
  if (!cert) missing.push('cert');
  if (!key) missing.push('key');
  if (requireMtls && missing.length) {
    const err = new Error(`mtls_required:${missing.join(',')}`);
    err.code = 'mtls_required';
    err.missing = missing;
    throw err;
  }
  if (missing.length) {
    const err = new Error(`tls_material_incomplete:${missing.join(',')}`);
    err.code = 'tls_material_incomplete';
    err.missing = missing;
    throw err;
  }
  return {
    tls: { ca, cert, key },
  };
}

/**
 * Reject cleartext-only connect when mTLS is required.
 * Allows nats:// / tls:// / wss:// hosts; the tls option object is what enforces mTLS.
 *
 * @param {string} url
 * @param {{ tls?: object } | null | undefined} connectOpts
 * @param {{ requireMtls?: boolean }} [policy]
 */
function assertNatsMtlsConnect(url, connectOpts, policy = {}) {
  const requireMtls = policy.requireMtls !== false;
  if (typeof url !== 'string' || !url) {
    const err = new Error('nats_url_required');
    err.code = 'nats_url_required';
    throw err;
  }
  const lower = url.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('ws://')) {
    const err = new Error('nats_plaintext_transport_forbidden');
    err.code = 'nats_plaintext_transport_forbidden';
    throw err;
  }
  if (!requireMtls) return;
  const tls = connectOpts && connectOpts.tls;
  if (!tls || !tls.ca || !tls.cert || !tls.key) {
    const err = new Error('mtls_required:connect_opts');
    err.code = 'mtls_required';
    throw err;
  }
}

module.exports = {
  buildNatsTlsOptions,
  assertNatsMtlsConnect,
};
