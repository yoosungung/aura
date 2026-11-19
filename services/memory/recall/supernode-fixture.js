'use strict';

/**
 * Supernode fixture for defensive graph walk (M4).
 * Contract: ARCHITECTURE §6.2.4 · deploy/docs/memory-graph-supernode-fixture.md
 *
 * Hub degree ≫ supernode_degree_cap / per_hop_limit. Fake PG honors LIMIT
 * so walk cannot explode by fetching the full adjacency list.
 *
 * Non-goals: live PG apply · schema change · RRF tuning.
 */

const { GRAPH_LIMITS, expandLimitForNode } = require('./graph-walk');

/** Fixed fixture size — must stay ≫ GRAPH_LIMITS caps. */
const HUB_DEGREE = 500;

/**
 * Build in-memory hub + spokes.
 * @param {{ hub_degree?: number }} [opts]
 */
function buildSupernodeFixture(opts) {
  const hubDegree = opts && opts.hub_degree != null ? Number(opts.hub_degree) : HUB_DEGREE;
  const hub = { node_id: 'hub', item_id: 'hub-item' };
  const out = [];
  for (let i = 0; i < hubDegree; i++) {
    out.push({
      edge_id: `e-out-${i}`,
      source_node_id: 'hub',
      target_node_id: `spoke-${i}`,
      relation_type: 'relates',
      neighbor_item_id: `spoke-item-${i}`,
      direction: 'out',
    });
  }
  return {
    tenant_id: 'tenant-supernode',
    hub_degree: hubDegree,
    nodes: [hub],
    out,
    in: [],
  };
}

/**
 * Fake client: stores full hub adjacency but returns at most LIMIT rows
 * (mirrors PG LIMIT on idx_memory_edges_out/in).
 *
 * @param {ReturnType<typeof buildSupernodeFixture>} fixture
 */
function makeSupernodeClient(fixture) {
  const calls = [];
  let rowsReturned = 0;
  let maxLimitParam = 0;

  const client = {
    async query(text, params) {
      calls.push({ text, params });
      const t = String(text);
      if (/FROM memory_nodes/i.test(t) && /item_id/i.test(t)) {
        const ids = (params && params[1]) || [];
        const rows = (fixture.nodes || []).filter((n) => ids.includes(n.item_id));
        return { rows };
      }
      if (/FROM memory_edges/i.test(t) && /source_node_id\s*=/i.test(t)) {
        const sourceId = params[1];
        const limit = Number(params[2]);
        if (Number.isFinite(limit)) maxLimitParam = Math.max(maxLimitParam, limit);
        const rows = (fixture.out || [])
          .filter((e) => e.source_node_id === sourceId)
          .slice(0, Math.max(0, limit));
        rowsReturned += rows.length;
        return { rows };
      }
      if (/FROM memory_edges/i.test(t) && /target_node_id\s*=/i.test(t)) {
        const targetId = params[1];
        const limit = Number(params[2]);
        if (Number.isFinite(limit)) maxLimitParam = Math.max(maxLimitParam, limit);
        const rows = (fixture.in || [])
          .filter((e) => e.target_node_id === targetId)
          .slice(0, Math.max(0, limit));
        rowsReturned += rows.length;
        return { rows };
      }
      return { rows: [] };
    },
  };

  return {
    client,
    calls,
    stats: () => ({
      query_n: calls.length,
      edge_query_n: calls.filter((c) => /memory_edges/i.test(c.text)).length,
      rows_returned: rowsReturned,
      max_limit_param: maxLimitParam,
    }),
  };
}

/**
 * OFF contrast: read hub with limit = hub_degree (no walk cap).
 * @param {ReturnType<typeof buildSupernodeFixture>} fixture
 */
function probeUncappedHubDegree(fixture) {
  return (fixture.out || []).filter((e) => e.source_node_id === 'hub').length;
}

module.exports = {
  HUB_DEGREE,
  GRAPH_LIMITS,
  expandLimitForNode,
  buildSupernodeFixture,
  makeSupernodeClient,
  probeUncappedHubDegree,
};
