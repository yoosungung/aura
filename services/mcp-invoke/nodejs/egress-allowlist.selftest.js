'use strict';

const assert = require('assert');
const {
  DEFAULT_POLICY,
  parseDestination,
  decideEgress,
  assertAllowed,
} = require('./egress-allowlist');

function main() {
  const dns = parseDestination('kube-dns.kube-system.svc.cluster.local:53');
  assert.strictEqual(dns.host, 'kube-dns.kube-system.svc.cluster.local');
  assert.strictEqual(dns.port, 53);

  const https = parseDestination('https://mcp.tenant.example/mcp');
  assert.strictEqual(https.host, 'mcp.tenant.example');
  assert.strictEqual(https.port, 443);
  assert.strictEqual(https.scheme, 'https');

  const policy = {
    ...DEFAULT_POLICY,
    mcpHosts: ['mcp.tenant.example', 'tools.partner.example'],
    objectStoreHosts: ['rustfs.aura.svc.cluster.local'],
  };

  const allowCases = [
    ['nats.aura.svc.cluster.local:4222', 'nats'],
    ['aura-pg-pooler.aura.svc.cluster.local:5432', 'pooler'],
    ['aura-llm-gateway.aura.svc.cluster.local:8080', 'llm_gateway'],
    ['rustfs.aura.svc.cluster.local:443', 'object_store'],
    ['https://mcp.tenant.example/v1', 'mcp'],
    ['kube-dns.kube-system.svc.cluster.local:53', 'dns'],
  ];
  for (const [dest, role] of allowCases) {
    const d = decideEgress(dest, policy);
    assert.strictEqual(d.ok, true, `expected allow ${dest}`);
    assert.strictEqual(d.role, role);
  }

  const denyCases = [
    'https://evil.example/',
    'https://api.openai.com/v1/chat',
    'https://api.anthropic.com/v1/messages',
    'aura-pg-rw.aura.svc.cluster.local:5432',
    '169.254.169.254',
    'https://metadata.google.internal/',
    'https://unregistered-mcp.example/mcp',
  ];
  for (const dest of denyCases) {
    const d = decideEgress(dest, policy);
    assert.strictEqual(d.ok, false, `expected deny ${dest}`);
    assert.strictEqual(d.reason, 'egress_denied');
    assert.throws(() => assertAllowed(dest, policy), /egress_denied/);
  }

  // Platform-signed must not relax allowlist.
  const signed = decideEgress('https://evil.example/', {
    ...policy,
    platformSigned: true,
  });
  assert.strictEqual(signed.ok, false);

  console.log('egress-allowlist.selftest: PASS');
}

main();
