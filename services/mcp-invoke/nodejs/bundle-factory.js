'use strict';

const crypto = require('crypto');

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

function sha256Prefixed(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function loadFactoryFromBundle(bytes, entrypoint) {
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

/**
 * Signed bundle only. Caller has already required sig_uri.
 * @param {object} source
 * @param {object} cfg
 * @param {object} deps — loadBundle(source) -> bytes, secrets_ref
 */
async function openBundleFactory(source, cfg, deps) {
  const d = deps || {};
  if (typeof d.loadBundle !== 'function') {
    const err = new Error('bundle_missing');
    err.status = 422;
    throw err;
  }
  const raw = await d.loadBundle(source);
  if (raw == null) {
    const err = new Error('bundle_missing');
    err.status = 422;
    throw err;
  }
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const digest = sha256Prefixed(body);
  if (digest !== source.checksum) {
    const err = new Error('bundle_checksum_mismatch');
    err.status = 422;
    throw err;
  }
  const factory = loadFactoryFromBundle(body, source.entrypoint);
  const instance = await Promise.resolve(factory(cfg, d.secrets_ref || null));
  if (!instance || typeof instance !== 'object') {
    const err = new Error('factory_instance_missing');
    err.status = 500;
    throw err;
  }
  return {
    async listTools(ctx) {
      const fn = instance.listTools || instance.list_tools;
      if (typeof fn !== 'function') {
        const err = new Error('factory_list_missing');
        err.status = 500;
        throw err;
      }
      return fn.call(instance, ctx);
    },
    async runTool(ctx) {
      const fn = instance.runTool || instance.run_tool;
      if (typeof fn !== 'function') {
        const err = new Error('factory_run_missing');
        err.status = 500;
        throw err;
      }
      return fn.call(instance, ctx);
    },
  };
}

module.exports = {
  isModuleEntrypoint,
  sha256Prefixed,
  loadFactoryFromBundle,
  openBundleFactory,
};
