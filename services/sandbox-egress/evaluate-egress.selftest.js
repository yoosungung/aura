'use strict';

const assert = require('assert');
const path = require('path');
const {
  loadSandboxEgressRules,
  decideNpEgress,
  decideSandboxEgress,
} = require('./evaluate-egress');
const { DEFAULT_POLICY } = require('../mcp-invoke/egress-allowlist');

function main() {
  const manifestDir = path.join(__dirname, '../../deploy/k8s/sandbox-egress');
  const rules = loadSandboxEgressRules(manifestDir);
  assert.ok(rules.length >= 6, 'expected allowlist egress rules');

  const npAllow = [
    'nats.aura.svc.cluster.local:4222',
    'aura-pg-pooler.aura.svc.cluster.local:5432',
    'aura-llm-gateway.aura.svc.cluster.local:8080',
    'rustfs.aura.svc.cluster.local:9000',
    'kube-dns.kube-system.svc.cluster.local:53',
    'aura-mcp-proxy.aura.svc.cluster.local:443',
  ];
  for (const dest of npAllow) {
    const d = decideNpEgress(dest, { rules });
    assert.strictEqual(d.ok, true, `NP allow ${dest}`);
  }

  const npDeny = [
    'aura-pg-rw.aura.svc.cluster.local:5432',
    '169.254.169.254:80',
    '10.0.0.99:443',
  ];
  for (const dest of npDeny) {
    const d = decideNpEgress(dest, { rules });
    assert.strictEqual(d.ok, false, `NP deny ${dest}`);
  }

  const appPolicy = {
    ...DEFAULT_POLICY,
    mcpHosts: ['mcp.tenant.example'],
    objectStoreHosts: ['rustfs.aura.svc.cluster.local'],
  };

  const combinedAllow = [
    ['nats.aura.svc.cluster.local:4222', 'np'],
    ['https://mcp.tenant.example/mcp', 'app'],
  ];
  for (const [dest, layer] of combinedAllow) {
    const d = decideSandboxEgress(dest, { manifestDir, appPolicy });
    assert.strictEqual(d.ok, true, `combined allow ${dest}`);
    assert.strictEqual(d.layer, layer);
  }

  const combinedDeny = [
    'https://api.openai.com/v1/chat/completions',
    'https://evil.example/',
    'https://unregistered-mcp.example/mcp',
    'https://metadata.google.internal/',
    'aura-pg-rw.aura.svc.cluster.local:5432',
  ];
  for (const dest of combinedDeny) {
    const d = decideSandboxEgress(dest, { manifestDir, appPolicy });
    assert.strictEqual(d.ok, false, `combined deny ${dest}`);
  }

  console.log('evaluate-egress.selftest: PASS');
}

main();