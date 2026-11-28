#!/usr/bin/env node
'use strict';

/**
 * Documents sandbox egress allow/deny matrix (V3.3 smoke evidence).
 * Default: print expected results (offline). With AURA_EGRESS_LIVE=1 + kubectl,
 * optionally probes from a labeled sandbox pod (see egress-block-verify.md).
 */

const path = require('path');
const { decideSandboxEgress } = require('../../../services/sandbox-egress/evaluate-egress');
const { DEFAULT_POLICY } = require('../../../services/mcp-invoke/nodejs/egress-allowlist');

const MANIFEST_DIR = path.join(__dirname);
const APP_POLICY = {
  ...DEFAULT_POLICY,
  mcpHosts: ['mcp.tenant.example'],
  objectStoreHosts: ['rustfs.aura.svc.cluster.local'],
};

const MATRIX = [
  { dest: 'nats.aura.svc.cluster.local:4222', expect: 'allow', note: 'NATS' },
  { dest: 'aura-pg-pooler.aura.svc.cluster.local:5432', expect: 'allow', note: 'Pooler' },
  { dest: 'aura-llm-gateway.aura.svc.cluster.local:8080', expect: 'allow', note: 'LLM Gateway' },
  { dest: 'rustfs.aura.svc.cluster.local:9000', expect: 'allow', note: 'aura-content' },
  { dest: 'kube-dns.kube-system.svc.cluster.local:53', expect: 'allow', note: 'DNS' },
  { dest: 'aura-mcp-proxy.aura.svc.cluster.local:443', expect: 'allow', note: 'MCP proxy' },
  { dest: 'https://mcp.tenant.example/mcp', expect: 'allow', note: 'registered MCP (app)' },
  { dest: 'https://api.openai.com/v1', expect: 'deny', note: 'provider LLM direct' },
  { dest: '169.254.169.254', expect: 'deny', note: 'metadata' },
  { dest: 'https://evil.example/', expect: 'deny', note: 'random internet' },
  { dest: 'https://unregistered-mcp.example/mcp', expect: 'deny', note: 'unregistered MCP' },
  { dest: 'aura-pg-rw.aura.svc.cluster.local:5432', expect: 'deny', note: 'PG primary direct' },
];

function main() {
  let failed = 0;
  console.log('== sandbox egress matrix (offline simulator) ==');
  for (const row of MATRIX) {
    const d = decideSandboxEgress(row.dest, {
      manifestDir: MANIFEST_DIR,
      appPolicy: APP_POLICY,
    });
    const got = d.ok ? 'allow' : 'deny';
    const ok = got === row.expect;
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK' : 'FAIL'}  ${row.expect.toUpperCase().padEnd(5)}  ${row.dest}  (${row.note})`);
  }
  if (failed) {
    console.error(`smoke-probe: FAIL (${failed} mismatches)`);
    process.exit(1);
  }
  if (process.env.AURA_EGRESS_LIVE === '1') {
    console.log('AURA_EGRESS_LIVE=1: live kubectl probe is optional; see deploy/docs/egress-block-verify.md');
  }
  console.log('smoke-probe: PASS');
}

main();