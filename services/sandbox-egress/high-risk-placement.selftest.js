'use strict';

const assert = require('assert');
const {
  decidePlacement,
  POOL_KATA,
  POOL_DEFAULT,
  RC_KATA,
  RC_GVISOR,
} = require('./high-risk-placement');

function expect(input, want) {
  const got = decidePlacement(input);
  assert.strictEqual(got.allow, want.allow, JSON.stringify({ input, got, want }));
  if (want.runtimeClass) {
    assert.strictEqual(got.runtimeClass, want.runtimeClass);
  }
  if (want.pool) {
    assert.strictEqual(got.pool, want.pool);
  }
  if (want.reason) {
    assert.strictEqual(got.reason, want.reason);
  }
}

// high → kata only
expect(
  { risk_tier: 'high', runtimeClassName: 'kata' },
  { allow: true, runtimeClass: RC_KATA, pool: POOL_KATA, reason: 'high_risk_kata_pool' },
);
expect({ risk_tier: 'high', runtimeClassName: 'gvisor' }, { allow: false, reason: 'high_risk_requires_kata' });
expect({ risk_tier: 'high' }, { allow: false, reason: 'high_risk_requires_kata' });
expect({ risk_tier: 'high', runtimeClassName: 'runc' }, { allow: false, reason: 'runc_forbidden_for_tenant_code' });

// standard → gvisor; no kata pool squat
expect(
  { risk_tier: 'standard', runtimeClassName: 'gvisor' },
  { allow: true, runtimeClass: RC_GVISOR, pool: POOL_DEFAULT, reason: 'standard_gvisor_default' },
);
expect(
  { risk_tier: 'standard' },
  { allow: true, runtimeClass: RC_GVISOR, pool: POOL_DEFAULT, reason: 'standard_gvisor_default' },
);
expect(
  { risk_tier: 'standard', runtimeClassName: 'kata' },
  { allow: false, reason: 'standard_must_not_use_kata_pool' },
);
expect(
  { risk_tier: 'standard', runtimeClassName: 'runc' },
  { allow: false, reason: 'runc_forbidden_for_tenant_code' },
);

// unknown tier
expect({ risk_tier: 'gold', runtimeClassName: 'gvisor' }, { allow: false, reason: 'unknown_risk_tier' });

console.log('high-risk-placement.selftest: PASS');
