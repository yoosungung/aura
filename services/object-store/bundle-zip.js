'use strict';

/**
 * Tenant bundle zip helpers (ARCHITECTURE §1 #11 · §7 · deploy/docs/tenant-bundle-multifile.md).
 */

const path = require('path');
const zlib = require('zlib');

function fail(code, status) {
  const err = new Error(code);
  err.status = status || 422;
  return err;
}

function isZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function normalizeZipPath(name) {
  let n = String(name || '').replace(/\\/g, '/');
  if (n.startsWith('/')) n = n.slice(1);
  if (!n || n.endsWith('/')) return null;
  const parts = n.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw fail('bundle_zip_unsafe_path', 422);
  }
  if (parts[0] === 'node_modules' || parts.includes('node_modules')) {
    throw fail('bundle_zip_node_modules_forbidden', 422);
  }
  if (parts.includes('__pycache__') || parts.some((p) => p.endsWith('.pyc'))) {
    throw fail('bundle_zip_pycache_forbidden', 422);
  }
  return parts.join('/');
}

function readU32(buf, off) {
  return buf.readUInt32LE(off);
}
function readU16(buf, off) {
  return buf.readUInt16LE(off);
}

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
function unzipToMap(buf) {
  if (!isZip(buf)) throw fail('bundle_not_zip', 422);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65536 - 22; i -= 1) {
    if (readU32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail('bundle_zip_corrupt', 422);
  const count = readU16(buf, eocd + 10);
  let offset = readU32(buf, eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (readU32(buf, offset) !== 0x02014b50) throw fail('bundle_zip_corrupt', 422);
    const method = readU16(buf, offset + 10);
    const compSize = readU32(buf, offset + 20);
    const uncompSize = readU32(buf, offset + 24);
    const nameLen = readU16(buf, offset + 28);
    const extraLen = readU16(buf, offset + 30);
    const commentLen = readU16(buf, offset + 32);
    const localOff = readU32(buf, offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    const norm = normalizeZipPath(name);
    if (!norm) continue;
    if (readU32(buf, localOff) !== 0x04034b50) throw fail('bundle_zip_corrupt', 422);
    const localNameLen = readU16(buf, localOff + 26);
    const localExtraLen = readU16(buf, localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw fail('bundle_zip_method_unsupported', 422);
    }
    if (data.length !== uncompSize && uncompSize !== 0) {
      // some writers leave uncompSize 0 for dirs; files should match
      if (uncompSize !== 0) throw fail('bundle_zip_corrupt', 422);
    }
    out.set(norm, data);
  }
  return stripSingleRootDir(out);
}

/** If every path shares one top-level folder, strip it (Finder / scaffold zip habit). */
function stripSingleRootDir(files) {
  if (files.size === 0) return files;
  const keys = [...files.keys()];
  const roots = new Set(keys.map((k) => k.split('/')[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0];
  if (!keys.every((k) => k.startsWith(root + '/'))) return files;
  const next = new Map();
  for (const [k, v] of files) {
    next.set(k.slice(root.length + 1), v);
  }
  return next;
}

function splitEntrypoint(entrypoint) {
  if (typeof entrypoint !== 'string') throw fail('entrypoint_invalid', 400);
  const i = entrypoint.indexOf(':');
  if (i <= 0 || i !== entrypoint.lastIndexOf(':')) throw fail('entrypoint_invalid', 400);
  const mod = entrypoint.slice(0, i);
  const attr = entrypoint.slice(i + 1);
  if (!attr || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(attr)) throw fail('entrypoint_invalid', 400);
  if (mod.startsWith('aura')) throw fail('entrypoint_invalid', 400);
  if (mod.split(/[/./]/).some((p) => p === '..' || p === '')) {
    throw fail('entrypoint_invalid', 400);
  }
  return { mod, attr };
}

/**
 * Resolve module path inside zip map for given language ext.
 * @param {Map<string, Buffer>} files
 * @param {string} mod entrypoint module (main | lib/agent | lib.agent)
 * @param {'.js'|'.py'} ext
 */
function resolveEntryFile(files, mod, ext) {
  const candidates = [];
  const slash = mod.replace(/\./g, '/');
  candidates.push(slash + ext);
  candidates.push(slash);
  if (!slash.endsWith(ext)) {
    // already added
  }
  for (const c of candidates) {
    const n = normalizeZipPath(c);
    if (n && files.has(n)) return n;
  }
  throw fail('bundle_entry_missing', 422);
}

/**
 * Load CommonJS factory from plain source or zip.
 * Relative require('./x') resolves inside zip; bare require uses platformRequire.
 */
function loadJsFactory(bytes, entrypoint, platformRequire) {
  const req = platformRequire || require;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { mod, attr } = splitEntrypoint(entrypoint);

  if (!isZip(buf)) {
    const module = { exports: {} };
    const compiled = new Function('module', 'exports', 'require', buf.toString('utf8'));
    compiled(module, module.exports, req);
    const factory = module.exports && module.exports[attr];
    if (typeof factory !== 'function') throw fail('factory_export_missing', 500);
    return factory;
  }

  const files = unzipToMap(buf);
  const entryFile = resolveEntryFile(files, mod, '.js');
  const cache = new Map();

  function loadModule(filePath) {
    const normalized = normalizeZipPath(filePath);
    if (!normalized || !files.has(normalized)) {
      throw fail('bundle_module_missing', 422);
    }
    if (cache.has(normalized)) return cache.get(normalized).exports;
    const module = { exports: {} };
    cache.set(normalized, module);
    const dir = path.posix.dirname(normalized);
    const code = files.get(normalized).toString('utf8');
    const localRequire = (id) => {
      if (typeof id !== 'string') throw fail('bundle_require_invalid', 422);
      if (id.startsWith('node_modules/') || id === 'node_modules') {
        throw fail('bundle_zip_node_modules_forbidden', 422);
      }
      if (id.startsWith('.')) {
        let target = path.posix.normalize(path.posix.join(dir, id));
        if (target.startsWith('../') || target === '..') {
          throw fail('bundle_zip_unsafe_path', 422);
        }
        if (!target.endsWith('.js')) target += '.js';
        return loadModule(target);
      }
      return req(id);
    };
    const compiled = new Function('module', 'exports', 'require', code);
    compiled(module, module.exports, localRequire);
    return module.exports;
  }

  const exports = loadModule(entryFile);
  const factory = exports && exports[attr];
  if (typeof factory !== 'function') throw fail('factory_export_missing', 500);
  return factory;
}

module.exports = {
  isZip,
  unzipToMap,
  stripSingleRootDir,
  normalizeZipPath,
  splitEntrypoint,
  resolveEntryFile,
  loadJsFactory,
};
