'use strict';

const { BUNDLE_CACHE_MAX_BYTES, assertBundleUri, getObject, sha256Prefixed } = require('./get-object');

function createBundleCache(opts) {
  const maxBytes = (opts && opts.maxBytes) || BUNDLE_CACHE_MAX_BYTES;
  const map = new Map();
  let used = 0;
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const hit = map.get(key);
      map.delete(key);
      map.set(key, hit);
      return hit.bytes;
    },
    set(key, bytes) {
      if (!key || !Buffer.isBuffer(bytes)) return;
      const size = bytes.length;
      if (size > maxBytes) return;
      if (map.has(key)) {
        used -= map.get(key).size;
        map.delete(key);
      }
      while (map.size && used + size > maxBytes) {
        const oldest = map.keys().next().value;
        used -= map.get(oldest).size;
        map.delete(oldest);
      }
      map.set(key, { bytes, size });
      used += size;
    },
    reset() {
      map.clear();
      used = 0;
    },
  };
}

const processCache = createBundleCache();

async function loadCachedBundle(source, opts) {
  const o = opts || {};
  const src = source && typeof source === 'object' ? source : {};
  assertBundleUri(src.bundle_uri, o.tenantId);
  const cache = o.cache || processCache;
  const checksum = typeof src.checksum === 'string' ? src.checksum : '';
  if (checksum) {
    const hit = cache.get(checksum);
    if (hit) return hit;
  }
  const body = await getObject(src.bundle_uri, o);
  if (checksum) {
    if (sha256Prefixed(body) !== checksum) {
      const err = new Error('bundle_checksum_mismatch');
      err.status = 422;
      throw err;
    }
    cache.set(checksum, body);
  }
  return body;
}

function resetProcessBundleCache() {
  processCache.reset();
}

module.exports = {
  createBundleCache,
  loadCachedBundle,
  resetProcessBundleCache,
};
