'use strict';

/**
 * svc-control resolve wire helpers (M3 minimal).
 * Contract: ARCHITECTURE §1 #6·#11 · deploy/docs/svc-control-resolve.md
 * Non-goals: HTTP admin server · live PG pool client (bridge Warm: ./bridge.js).
 */

const KINDS = new Set(['agent', 'mcp']);
const RUNTIMES = new Set(['nodejs', 'python', 'custom']);
const DEFAULT_RUNTIME = 'nodejs';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Normalize source_meta.runtime (func-env). Invalid/missing → nodejs. */
function normalizeRuntime(v) {
  if (typeof v === 'string' && RUNTIMES.has(v)) return v;
  return DEFAULT_RUNTIME;
}

/** 1-depth section merge; user wins. Source/user objects are not mutated. */
function mergeConfigs(sourceCfg, userCfg) {
  const base = isPlainObject(sourceCfg) ? { ...sourceCfg } : {};
  if (!isPlainObject(userCfg) || Object.keys(userCfg).length === 0) {
    return base;
  }
  const out = { ...base };
  for (const [key, userVal] of Object.entries(userCfg)) {
    const srcVal = out[key];
    if (isPlainObject(srcVal) && isPlainObject(userVal)) {
      out[key] = { ...srcVal, ...userVal };
    } else {
      out[key] = userVal;
    }
  }
  return out;
}

function validateResolveRequest(req) {
  if (!isPlainObject(req)) {
    return { ok: false, error: 'request_not_object' };
  }
  const { tenant_id, kind, name, version, principal } = req;
  if (typeof tenant_id !== 'string' || !tenant_id) {
    return { ok: false, error: 'tenant_id_required' };
  }
  if (!KINDS.has(kind)) {
    return { ok: false, error: 'kind_invalid' };
  }
  if (typeof name !== 'string' || !name) {
    return { ok: false, error: 'name_required' };
  }
  if (typeof version !== 'string' || !version) {
    return { ok: false, error: 'version_required' };
  }
  if (!isPlainObject(principal) || typeof principal.id !== 'string' || !principal.id) {
    return { ok: false, error: 'principal_id_required' };
  }
  if (typeof principal.tenant_id !== 'string' || !principal.tenant_id) {
    return { ok: false, error: 'principal_tenant_required' };
  }
  if (principal.tenant_id !== tenant_id) {
    return { ok: false, error: 'tenant_mismatch' };
  }
  return { ok: true };
}

function publicSource(source) {
  return {
    id: source.id,
    tenant_id: source.tenant_id,
    kind: source.kind,
    name: source.name,
    version: source.version,
    entrypoint: source.entrypoint,
    bundle_uri: source.bundle_uri,
    checksum: source.checksum,
    sig_uri: source.sig_uri ?? null,
    config: source.config && typeof source.config === 'object' ? source.config : {},
    runtime: normalizeRuntime(source.runtime),
    status: source.status,
    created_at: source.created_at,
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    tenant_id: user.tenant_id,
    source_meta_id: user.source_meta_id,
    principal_id: user.principal_id,
    config: user.config && typeof user.config === 'object' ? user.config : {},
    secrets_ref: user.secrets_ref ?? null,
    updated_at: user.updated_at,
  };
}

/**
 * Build resolve RPC response from DB rows (already tenant-scoped).
 * Only status=active sources succeed.
 */
function buildResolveResponse({ source, user }) {
  if (!source || source.status !== 'active') {
    return {
      type: 'control.resolve.error',
      error: 'source_not_active',
    };
  }
  const src = publicSource(source);
  const usr = publicUser(user);
  return {
    type: 'control.resolve.done',
    source: src,
    user: usr,
    cfg: mergeConfigs(src.config, usr ? usr.config : null),
    secrets_ref: usr ? usr.secrets_ref : null,
    runtime: src.runtime,
  };
}

module.exports = {
  RUNTIMES,
  DEFAULT_RUNTIME,
  normalizeRuntime,
  mergeConfigs,
  validateResolveRequest,
  buildResolveResponse,
};
