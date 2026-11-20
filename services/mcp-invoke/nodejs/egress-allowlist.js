'use strict';

/**
 * Sandbox egress allowlist decision (ARCHITECTURE §9.1 · mcp-bundle-isolation).
 * App-layer gate for destinations NetworkPolicy cannot express as FQDN (MCP HTTPS).
 * L3/L4 in-cluster allowlist remains NetworkPolicy (deploy/k8s/sandbox-egress/).
 */

const DEFAULT_POLICY = Object.freeze({
  natsHosts: Object.freeze([
    'nats',
    'nats.aura',
    'nats.aura.svc',
    'nats.aura.svc.cluster.local',
  ]),
  natsPorts: Object.freeze([4222]),
  poolerHosts: Object.freeze([
    'aura-pg-pooler',
    'aura-pg-pooler.aura',
    'aura-pg-pooler.aura.svc',
    'aura-pg-pooler.aura.svc.cluster.local',
  ]),
  poolerPorts: Object.freeze([5432]),
  llmGatewayHosts: Object.freeze([
    'aura-llm-gateway',
    'aura-llm-gateway.aura',
    'aura-llm-gateway.aura.svc',
    'aura-llm-gateway.aura.svc.cluster.local',
  ]),
  llmGatewayPorts: Object.freeze([80, 443, 8080]),
  objectStoreHosts: Object.freeze([]),
  objectStorePorts: Object.freeze([80, 443, 3900]),
  dnsHosts: Object.freeze([
    'kube-dns.kube-system',
    'kube-dns.kube-system.svc',
    'kube-dns.kube-system.svc.cluster.local',
    'coredns.kube-system',
    'coredns.kube-system.svc',
    'coredns.kube-system.svc.cluster.local',
  ]),
  dnsPorts: Object.freeze([53]),
  mcpHosts: Object.freeze([]),
  mcpPorts: Object.freeze([443, 80]),
  platformSigned: false,
});

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

/**
 * @param {string} input URL or host[:port]
 * @returns {{ host: string, port: number|null, scheme: string|null }}
 */
function parseDestination(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const err = new Error('destination_required');
    throw err;
  }
  let scheme = null;
  let rest = raw;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = raw.slice(schemeMatch[0].length);
  }
  const pathIdx = rest.search(/[/?#]/);
  if (pathIdx >= 0) rest = rest.slice(0, pathIdx);
  let host = rest;
  let port = null;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end > 0) {
      host = rest.slice(1, end);
      const after = rest.slice(end + 1);
      if (after.startsWith(':')) port = Number(after.slice(1));
    }
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > 0 && rest.indexOf(':') === colon) {
      host = rest.slice(0, colon);
      port = Number(rest.slice(colon + 1));
    }
  }
  host = normalizeHost(host);
  if (port != null && !Number.isFinite(port)) port = null;
  if (port == null && scheme === 'https') port = 443;
  if (port == null && scheme === 'http') port = 80;
  return { host, port, scheme };
}

function hostMatch(candidate, allowedList) {
  const h = normalizeHost(candidate);
  for (const a of allowedList || []) {
    const n = normalizeHost(a);
    if (!n) continue;
    if (h === n) return true;
    if (h.startsWith(`${n}.`)) return true;
  }
  return false;
}

function portOk(port, allowedPorts) {
  if (port == null) return true;
  return (allowedPorts || []).includes(port);
}

/**
 * @param {string} destination
 * @param {object} [policy]
 * @returns {{ ok: true, role: string } | { ok: false, reason: string }}
 */
function decideEgress(destination, policy) {
  const p = { ...DEFAULT_POLICY, ...(policy || {}) };
  let dest;
  try {
    dest = parseDestination(destination);
  } catch {
    return { ok: false, reason: 'egress_denied' };
  }
  if (!dest.host) return { ok: false, reason: 'egress_denied' };

  // Metadata / link-local — always deny (even if somehow listed).
  if (
    dest.host === '169.254.169.254' ||
    dest.host.endsWith('.metadata.google.internal') ||
    dest.host === 'metadata.google.internal' ||
    dest.host === 'metadata'
  ) {
    return { ok: false, reason: 'egress_denied' };
  }

  const checks = [
    ['nats', p.natsHosts, p.natsPorts],
    ['pooler', p.poolerHosts, p.poolerPorts],
    ['llm_gateway', p.llmGatewayHosts, p.llmGatewayPorts],
    ['object_store', p.objectStoreHosts, p.objectStorePorts],
    ['dns', p.dnsHosts, p.dnsPorts],
    ['mcp', p.mcpHosts, p.mcpPorts],
  ];
  for (const [role, hosts, ports] of checks) {
    if (hostMatch(dest.host, hosts) && portOk(dest.port, ports)) {
      return { ok: true, role };
    }
  }
  return { ok: false, reason: 'egress_denied' };
}

/**
 * @param {string} destination
 * @param {object} [policy]
 */
function assertAllowed(destination, policy) {
  const d = decideEgress(destination, policy);
  if (!d.ok) {
    const err = new Error('egress_denied');
    err.code = 'egress_denied';
    throw err;
  }
  return d;
}

module.exports = {
  DEFAULT_POLICY,
  parseDestination,
  decideEgress,
  assertAllowed,
  normalizeHost,
};
