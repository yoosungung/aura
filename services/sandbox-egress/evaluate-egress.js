'use strict';

/**
 * Offline NetworkPolicy egress simulator for deploy/k8s/sandbox-egress/.
 * Maps candidate destinations to labeled peers and checks manifest egress rules.
 * External MCP HTTPS uses app-layer allowlist (services/mcp-invoke/egress-allowlist.js).
 */

const fs = require('fs');
const path = require('path');
const {
  decideEgress: decideAppLayer,
  parseDestination,
  DEFAULT_POLICY,
} = require('../mcp-invoke/egress-allowlist');

/** @typedef {{ labels: Record<string,string>, namespace?: string, ports?: number[] }} Peer */

/** In-cluster DNS names → label set the NP rules target. */
const PEER_CATALOG = Object.freeze({
  'nats': { labels: { app: 'nats' }, namespace: 'aura', ports: [4222] },
  'nats.aura.svc.cluster.local': { labels: { app: 'nats' }, namespace: 'aura', ports: [4222] },
  'aura-pg-pooler.aura.svc.cluster.local': {
    labels: { 'aura.db/role': 'pooler' },
    namespace: 'aura',
    ports: [5432],
  },
  'aura-llm-gateway.aura.svc.cluster.local': {
    labels: { app: 'aura-llm-gateway' },
    namespace: 'aura',
    ports: [80, 443, 8080],
  },
  'garage.aura.svc.cluster.local': {
    labels: { app: 'aura-content' },
    namespace: 'aura',
    ports: [80, 443, 3900],
  },
  'aura-mcp-proxy.aura.svc.cluster.local': {
    labels: { app: 'aura-mcp-proxy' },
    namespace: 'aura',
    ports: [80, 443],
  },
  'kube-dns.kube-system.svc.cluster.local': {
    labels: { 'k8s-app': 'kube-dns' },
    namespace: 'kube-system',
    ports: [53],
  },
  'aura-pg-rw.aura.svc.cluster.local': {
    labels: { 'aura.db/role': 'primary' },
    namespace: 'aura',
    ports: [5432],
  },
});

const METADATA_DENY_HOSTS = Object.freeze([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
]);

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function catalogPeer(host) {
  const h = normalizeHost(host);
  if (PEER_CATALOG[h]) return PEER_CATALOG[h];
  for (const [key, peer] of Object.entries(PEER_CATALOG)) {
    if (h === key || h.endsWith(`.${key}`)) return peer;
  }
  return null;
}

function parseSimpleYamlEgressRules(yamlText) {
  const rules = [];
  const lines = yamlText.split(/\r?\n/);
  let inEgress = false;
  let depth = 0;
  let current = null;
  let pendingNs = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    if (/^\s*egress:\s*$/.test(line)) {
      inEgress = true;
      continue;
    }
    if (!inEgress) continue;
    if (/^\S/.test(line) && !/^\s*-\s/.test(line)) {
      if (!line.startsWith('  ') && !line.startsWith('\t')) break;
    }

    if (/^\s{2}-\s+to:\s*$/.test(line) || /^\s+-\s+to:\s*$/.test(line)) {
      if (current) rules.push(current);
      current = { podLabels: {}, namespaceLabels: {}, ports: [] };
      pendingNs = null;
      continue;
    }
    const podLabel = line.match(/^\s+app:\s+(\S+)/) || line.match(/^\s+matchLabels:\s*$/);
    const labelKv =
      line.match(/^\s+([a-zA-Z0-9._/-]+):\s+(\S+)\s*$/) ||
      line.match(/^\s{10,}([a-zA-Z0-9._/-]+):\s+(\S+)\s*$/);
    if (labelKv && current) {
      const key = labelKv[1];
      const val = labelKv[2].replace(/^["']|["']$/g, '');
      if (key === 'app' || key.startsWith('aura.') || key === 'k8s-app') {
        current.podLabels[key] = val;
      }
      if (key === 'kubernetes.io/metadata.name') {
        current.namespaceLabels[key] = val;
        pendingNs = val;
      }
    }
    const portMatch = line.match(/^\s+port:\s+(\d+)\s*$/);
    if (portMatch && current) {
      current.ports.push(Number(portMatch[1]));
    }
  }
  if (current) rules.push(current);
  return rules;
}

function loadSandboxEgressRules(manifestDir) {
  const npPath = path.join(manifestDir, 'networkpolicy-sandbox-egress.yaml');
  const text = fs.readFileSync(npPath, 'utf8');
  if (/\begress:\s*\[\s*\{\s*\}\s*\]/.test(text)) {
    throw new Error('networkpolicy must not contain open egress: [{}]');
  }
  if (/0\.0\.0\.0\/0/.test(text)) {
    throw new Error('networkpolicy must not contain 0.0.0.0/0 ipBlock');
  }
  return parseSimpleYamlEgressRules(text);
}

function labelsMatch(ruleLabels, peerLabels) {
  const keys = Object.keys(ruleLabels || {});
  if (!keys.length) return false;
  return keys.every((k) => peerLabels[k] === ruleLabels[k]);
}

function ruleAllowsPeer(rule, peer) {
  if (!labelsMatch(rule.podLabels, peer.labels)) return false;
  if (rule.namespaceLabels['kubernetes.io/metadata.name']) {
    const want = rule.namespaceLabels['kubernetes.io/metadata.name'];
    const ns = peer.namespace || 'aura';
    if (want !== ns) return false;
  }
  return true;
}

function npAllowsPort(rule, port) {
  if (!rule.ports.length) return true;
  if (port == null) return true;
  return rule.ports.includes(port);
}

/**
 * @param {string} destination host:port or URL
 * @param {{ rules?: object[], appPolicy?: object }} [opts]
 */
function decideNpEgress(destination, opts) {
  const dest = parseDestination(destination);
  if (METADATA_DENY_HOSTS.includes(dest.host)) {
    return { ok: false, layer: 'np', reason: 'metadata_denied' };
  }

  const peer = catalogPeer(dest.host);
  if (!peer) {
    return { ok: false, layer: 'np', reason: 'no_cluster_peer' };
  }

  const rules = opts?.rules || [];
  for (const rule of rules) {
    if (ruleAllowsPeer(rule, peer) && npAllowsPort(rule, dest.port)) {
      return { ok: true, layer: 'np', peer: dest.host };
    }
  }
  return { ok: false, layer: 'np', reason: 'np_denied' };
}

/**
 * Combined NP (in-cluster) + app-layer (external MCP HTTPS).
 * @param {string} destination
 * @param {{ manifestDir?: string, appPolicy?: object }} [opts]
 */
function decideSandboxEgress(destination, opts) {
  const manifestDir =
    opts?.manifestDir ||
    path.join(__dirname, '../../deploy/k8s/sandbox-egress');
  const rules = loadSandboxEgressRules(manifestDir);
  const dest = parseDestination(destination);

  if (METADATA_DENY_HOSTS.includes(dest.host)) {
    return { ok: false, reason: 'egress_denied' };
  }

  const np = decideNpEgress(destination, { rules });
  if (np.ok) return { ok: true, layer: 'np', role: inferRole(dest.host) };

  const app = decideAppLayer(destination, opts?.appPolicy || DEFAULT_POLICY);
  if (app.ok) return { ok: true, layer: 'app', role: app.role };

  return { ok: false, reason: 'egress_denied' };
}

function inferRole(host) {
  const p = catalogPeer(host);
  if (!p) return 'unknown';
  if (p.labels.app === 'nats') return 'nats';
  if (p.labels['aura.db/role'] === 'pooler') return 'pooler';
  if (p.labels.app === 'aura-llm-gateway') return 'llm_gateway';
  if (p.labels.app === 'aura-content') return 'object_store';
  if (p.labels['k8s-app'] === 'kube-dns') return 'dns';
  if (p.labels.app === 'aura-mcp-proxy') return 'mcp_proxy';
  return 'unknown';
}

module.exports = {
  PEER_CATALOG,
  loadSandboxEgressRules,
  decideNpEgress,
  decideSandboxEgress,
  parseDestination,
};