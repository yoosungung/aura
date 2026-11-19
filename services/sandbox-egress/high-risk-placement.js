'use strict';

/**
 * Offline placement policy for high-risk tenants (M5 · §9.1).
 * Decide RuntimeClass + pool; no cluster calls.
 * @see deploy/docs/high-risk-tenant-nodepool.md
 */

const POOL_KATA = 'kata';
const POOL_DEFAULT = 'default';
const RC_KATA = 'kata';
const RC_GVISOR = 'gvisor';
const RC_RUNC = 'runc';

/**
 * @param {{ risk_tier?: string, runtimeClassName?: string|null }} input
 * @returns {{ allow: boolean, runtimeClass?: string, pool?: string, reason: string }}
 */
function decidePlacement(input) {
  const tier = String(input?.risk_tier || 'standard').toLowerCase();
  const rcRaw = input?.runtimeClassName;
  const rc =
    rcRaw == null || rcRaw === ''
      ? null
      : String(rcRaw).toLowerCase();

  if (rc === RC_RUNC) {
    return { allow: false, reason: 'runc_forbidden_for_tenant_code' };
  }

  if (tier === 'high') {
    if (rc !== RC_KATA) {
      return {
        allow: false,
        reason: 'high_risk_requires_kata',
      };
    }
    return {
      allow: true,
      runtimeClass: RC_KATA,
      pool: POOL_KATA,
      reason: 'high_risk_kata_pool',
    };
  }

  // standard (and unknown → treat as standard deny-escalation)
  if (tier !== 'standard') {
    return { allow: false, reason: 'unknown_risk_tier' };
  }

  if (rc === RC_KATA) {
    return { allow: false, reason: 'standard_must_not_use_kata_pool' };
  }

  if (rc == null || rc === RC_GVISOR) {
    return {
      allow: true,
      runtimeClass: RC_GVISOR,
      pool: POOL_DEFAULT,
      reason: 'standard_gvisor_default',
    };
  }

  return { allow: false, reason: 'unsupported_runtime_class' };
}

module.exports = {
  decidePlacement,
  POOL_KATA,
  POOL_DEFAULT,
  RC_KATA,
  RC_GVISOR,
  RC_RUNC,
};
