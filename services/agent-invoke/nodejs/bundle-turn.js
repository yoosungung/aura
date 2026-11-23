'use strict';

const fs = require('fs');
const path = require('path');

function requireObjectStore(file) {
  const candidates = [
    path.join(__dirname, file),
    path.join(__dirname, '..', '..', 'object-store', file),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  const err = new Error('object_store_module_missing');
  err.status = 500;
  throw err;
}

function isModuleEntrypoint(entrypoint) {
  if (typeof entrypoint !== 'string') return false;
  const i = entrypoint.indexOf(':');
  if (i <= 0 || i !== entrypoint.lastIndexOf(':')) return false;
  const mod = entrypoint.slice(0, i);
  const attr = entrypoint.slice(i + 1);
  if (!attr || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(attr)) return false;
  if (mod.startsWith('aura')) return false;
  return true;
}

function loadJsFactory(bytes, entrypoint) {
  const attr = String(entrypoint).slice(String(entrypoint).lastIndexOf(':') + 1);
  const code = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const module = { exports: {} };
  const compiled = new Function('module', 'exports', 'require', code);
  compiled(module, module.exports, require);
  const factory = module.exports && module.exports[attr];
  if (typeof factory !== 'function') {
    const err = new Error('factory_export_missing');
    err.status = 500;
    throw err;
  }
  return factory;
}

function cacheOpts(deps, tenantId) {
  const d = deps || {};
  return {
    tenantId,
    fetchImpl: d.objectFetch,
    endpoint: d.objectEndpoint,
    region: d.objectRegion,
    accessKeyId: d.objectAccessKeyId,
    secretAccessKey: d.objectSecretAccessKey,
    cache: d.bundleCache,
    env: d.objectEnv,
  };
}

/**
 * module.path:attr + sig_uri → factory(cfg, secrets_ref).runTurn.
 * aura:createAgent and any other entrypoint return null (cfg createAgent, no GetObject).
 */
async function resolveAgentRunTurn(resolved, deps, tenantId) {
  const d = deps || {};
  const source = (resolved && resolved.source) || {};
  if (!isModuleEntrypoint(source.entrypoint)) {
    return d.runTurn || null;
  }
  if (!source.sig_uri || typeof source.sig_uri !== 'string') {
    const err = new Error('bundle_untrusted');
    err.status = 403;
    throw err;
  }
  const { sha256Prefixed } = requireObjectStore('get-object.js');
  const { loadCachedBundle } = requireObjectStore('bundle-cache.js');
  const load =
    typeof d.loadBundle === 'function'
      ? d.loadBundle
      : (src) => loadCachedBundle(src, cacheOpts(d, tenantId));
  const raw = await load(source);
  if (raw == null) {
    const err = new Error('bundle_missing');
    err.status = 422;
    throw err;
  }
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (sha256Prefixed(body) !== source.checksum) {
    const err = new Error('bundle_checksum_mismatch');
    err.status = 422;
    throw err;
  }
  const factory = loadJsFactory(body, source.entrypoint);
  const instance = await Promise.resolve(
    factory((resolved && resolved.cfg) || {}, (resolved && resolved.secrets_ref) || null),
  );
  const run = instance && (instance.runTurn || instance.run_turn);
  if (typeof run !== 'function') {
    const err = new Error('factory_export_missing');
    err.status = 500;
    throw err;
  }
  return (ctx) => run.call(instance, ctx);
}

module.exports = {
  resolveAgentRunTurn,
  isModuleEntrypoint,
  requireObjectStore,
};
