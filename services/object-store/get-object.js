'use strict';

const crypto = require('crypto');

const BUNDLE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const EMPTY_PAYLOAD_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function fail(code, status) {
  const err = new Error(code);
  err.status = status;
  return err;
}

function sha256Prefixed(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function assertBundleUri(uri, tenantId) {
  if (typeof uri !== 'string' || !uri.startsWith('s3://aura-content/')) {
    throw fail('bundle_uri_tenant_mismatch', 422);
  }
  if (uri.includes('?') || uri.includes('..')) {
    throw fail('bundle_uri_tenant_mismatch', 422);
  }
  if (typeof tenantId !== 'string' || !tenantId) {
    throw fail('bundle_uri_tenant_mismatch', 422);
  }
  const key = uri.slice('s3://aura-content/'.length);
  if (!('/' + key).includes(`/tenants/${tenantId}/bundles/`)) {
    throw fail('bundle_uri_tenant_mismatch', 422);
  }
  return key;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret, dateStamp, region) {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function encodeKey(key) {
  return key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function creds(opts) {
  const env = (opts && opts.env) || process.env;
  return {
    endpoint: (opts && opts.endpoint) || env.AURA_S3_ENDPOINT || '',
    region: (opts && opts.region) || env.AURA_S3_REGION || '',
    accessKeyId: (opts && opts.accessKeyId) || env.ACCESS_KEY_ID || '',
    secretAccessKey: (opts && opts.secretAccessKey) || env.ACCESS_SECRET_KEY || '',
  };
}

function authorizeGet(url, cred) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${EMPTY_PAYLOAD_HASH}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'GET',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_HASH,
  ].join('\n');
  const scope = `${dateStamp}/${cred.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(cred.secretAccessKey, dateStamp, cred.region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return {
    'x-amz-content-sha256': EMPTY_PAYLOAD_HASH,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function readBody(res) {
  if (!res) return null;
  if (typeof res.arrayBuffer === 'function') {
    return Buffer.from(await res.arrayBuffer());
  }
  if (Buffer.isBuffer(res.body)) return res.body;
  if (typeof res.body === 'string') return Buffer.from(res.body);
  if (res.body && typeof res.body === 'object' && typeof res.body.length === 'number') {
    return Buffer.from(res.body);
  }
  return null;
}

/**
 * @param {string} uri
 * @param {{ tenantId: string, fetchImpl?: Function, endpoint?: string, region?: string, accessKeyId?: string, secretAccessKey?: string, env?: object }} [opts]
 */
async function getObject(uri, opts) {
  const o = opts || {};
  const key = assertBundleUri(uri, o.tenantId);
  const cred = creds(o);
  if (!cred.endpoint || !cred.region || !cred.accessKeyId || !cred.secretAccessKey) {
    throw fail('object_store_unconfigured', 500);
  }
  const fetchImpl = o.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw fail('object_store_unconfigured', 500);
  }
  const base = String(cred.endpoint).replace(/\/$/, '');
  const url = new URL(`${base}/aura-content/${encodeKey(key)}`);
  const headers = authorizeGet(url, cred);
  let res;
  try {
    res = await fetchImpl(url.toString(), { method: 'GET', headers });
  } catch (_) {
    throw fail('bundle_missing', 422);
  }
  const status = res && res.status != null ? Number(res.status) : 200;
  if (status >= 300) {
    throw fail('bundle_missing', 422);
  }
  const body = await readBody(res);
  if (body == null) {
    throw fail('bundle_missing', 422);
  }
  return body;
}

module.exports = {
  BUNDLE_CACHE_MAX_BYTES,
  sha256Prefixed,
  assertBundleUri,
  getObject,
};
