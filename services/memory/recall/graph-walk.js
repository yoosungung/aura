'use strict';

/**
 * Defensive memory_edges walk for recall (M4).
 * Contract: ARCHITECTURE §1 #15 · §6.2.4 · deploy/docs/memory-graph-traversal.md
 *
 * Non-goals: live apply · unbounded recursive CTE · supernode fixture harness (별 티켓).
 */

const GRAPH_LIMITS = Object.freeze({
  max_depth: 2,
  per_hop_limit: 50,
  max_nodes_total: 100,
  max_edges_total: 200,
  supernode_degree_cap: 64,
});

/** Valid-edge SQL fragment (all traversal queries). */
const VALID_EDGE_PREDICATE =
  'valid_from <= now() AND (valid_until IS NULL OR valid_until > now())';

/**
 * Per-node expand cap = min(per_hop_limit, supernode_degree_cap).
 * @param {{ per_hop_limit: number, supernode_degree_cap: number }} limits
 */
function expandLimitForNode(limits) {
  const L = limits || GRAPH_LIMITS;
  return Math.min(L.per_hop_limit, L.supernode_degree_cap);
}

/**
 * Resolve seed item ids → memory_nodes.
 * @param {{ query: Function }} client
 */
async function resolveSeedNodes(client, tenantId, itemIds, limit) {
  const ids = [...new Set((itemIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return [];
  const sql = `
SELECT id::text AS node_id, item_id::text AS item_id, entity_type, name
FROM memory_nodes
WHERE tenant_id = $1::uuid
  AND item_id = ANY($2::uuid[])
LIMIT $3`;
  const res = await client.query(sql, [tenantId, ids, limit]);
  return res.rows || [];
}

/**
 * Fetch out+in edges for one node (hot-path indexes + valid predicate).
 * Joins neighbor item_id so RRF candidates need no second node round-trip.
 *
 * @param {{ query: Function }} client
 */
async function fetchNeighborEdges(client, tenantId, nodeId, limit) {
  const outSql = `
SELECT e.id::text AS edge_id,
       e.source_node_id::text AS source_node_id,
       e.target_node_id::text AS target_node_id,
       e.relation_type,
       n.item_id::text AS neighbor_item_id,
       'out' AS direction
FROM memory_edges e
LEFT JOIN memory_nodes n
  ON n.id = e.target_node_id AND n.tenant_id = e.tenant_id
WHERE e.tenant_id = $1::uuid
  AND e.source_node_id = $2::uuid
  AND ${VALID_EDGE_PREDICATE.replace(/valid_/g, 'e.valid_')}
ORDER BY e.created_at ASC, e.id ASC
LIMIT $3`;
  const inSql = `
SELECT e.id::text AS edge_id,
       e.source_node_id::text AS source_node_id,
       e.target_node_id::text AS target_node_id,
       e.relation_type,
       n.item_id::text AS neighbor_item_id,
       'in' AS direction
FROM memory_edges e
LEFT JOIN memory_nodes n
  ON n.id = e.source_node_id AND n.tenant_id = e.tenant_id
WHERE e.tenant_id = $1::uuid
  AND e.target_node_id = $2::uuid
  AND ${VALID_EDGE_PREDICATE.replace(/valid_/g, 'e.valid_')}
ORDER BY e.created_at ASC, e.id ASC
LIMIT $3`;

  // Selftests match unqualified valid_* — keep both shapes by also accepting
  // fixture SQL without alias. Prefer aliased production SQL above.
  // For fake clients that only filter on WHERE source/target, JOIN is ignored.
  const [outRes, inRes] = await Promise.all([
    client.query(outSql, [tenantId, nodeId, limit]),
    client.query(inSql, [tenantId, nodeId, limit]),
  ]);
  return [...(outRes.rows || []), ...(inRes.rows || [])];
}

/**
 * PG-backed defensive 1–2 hop walk.
 *
 * @param {{ query: Function }} client
 * @param {{ tenant_id: string, seed_item_ids?: string[], limits?: object }} opts
 */
async function walkGraph(client, opts) {
  const tenantId = opts.tenant_id;
  const limits = { ...GRAPH_LIMITS, ...(opts.limits || {}) };
  const expandCap = expandLimitForNode(limits);

  const seeds = await resolveSeedNodes(
    client,
    tenantId,
    opts.seed_item_ids || [],
    limits.max_nodes_total
  );

  const visited = new Set();
  const seedNodeIds = new Set();
  const seedItemIds = new Set();
  const candidates = [];
  const candidateIds = new Set();
  let edgesRead = 0;
  let nodesTotal = 0;
  let depthReached = 0;
  let truncated = false;

  for (const s of seeds) {
    const nid = String(s.node_id);
    visited.add(nid);
    seedNodeIds.add(nid);
    if (s.item_id) seedItemIds.add(String(s.item_id));
    nodesTotal += 1;
  }

  let frontier = seeds.map((s) => String(s.node_id));

  for (let depth = 1; depth <= limits.max_depth; depth++) {
    if (frontier.length === 0) break;
    const nextFrontier = [];

    for (const nodeId of frontier) {
      if (nodesTotal >= limits.max_nodes_total || edgesRead >= limits.max_edges_total) {
        truncated = true;
        break;
      }

      const remainEdges = limits.max_edges_total - edgesRead;
      const remainNodes = limits.max_nodes_total - nodesTotal;
      const fetchLimit = Math.min(expandCap, remainEdges, Math.max(remainNodes, 0) + expandCap);
      if (fetchLimit <= 0) {
        truncated = true;
        break;
      }

      const rows = await fetchNeighborEdges(client, tenantId, nodeId, fetchLimit);
      const capped = rows.slice(0, expandCap);

      for (const e of capped) {
        if (edgesRead >= limits.max_edges_total) {
          truncated = true;
          break;
        }
        edgesRead += 1;

        // Prefer explicit direction; fixture may omit it — infer from endpoints.
        let neighborId;
        if (e.direction === 'out') neighborId = String(e.target_node_id);
        else if (e.direction === 'in') neighborId = String(e.source_node_id);
        else if (String(e.source_node_id) === nodeId) neighborId = String(e.target_node_id);
        else neighborId = String(e.source_node_id);

        depthReached = Math.max(depthReached, depth);

        if (visited.has(neighborId)) continue;
        if (nodesTotal >= limits.max_nodes_total) {
          truncated = true;
          break;
        }

        visited.add(neighborId);
        nodesTotal += 1;
        nextFrontier.push(neighborId);

        const itemId = e.neighbor_item_id != null ? String(e.neighbor_item_id) : null;
        if (itemId && !seedItemIds.has(itemId) && !candidateIds.has(itemId)) {
          candidateIds.add(itemId);
          candidates.push({
            id: itemId,
            memory_type: 'semantic',
            source: 'graph',
            node_id: neighborId,
            depth,
            relation_type: e.relation_type || null,
          });
        }
      }

      if (rows.length > expandCap || capped.length >= expandCap && rows.length >= expandCap) {
        // hit per-node fan-out guard
        if (rows.length >= expandCap) truncated = true;
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = nextFrontier;
  }

  return {
    mode: 'walk',
    limits,
    candidates,
    stats: {
      edges_read: edgesRead,
      nodes_total: nodesTotal,
      depth_reached: depthReached,
      truncated,
      visited_n: visited.size,
    },
  };
}

module.exports = {
  GRAPH_LIMITS,
  VALID_EDGE_PREDICATE,
  expandLimitForNode,
  walkGraph,
  resolveSeedNodes,
  fetchNeighborEdges,
};
