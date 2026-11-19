'use strict';

const assert = require('assert');
const {
  GRAPH_LIMITS,
  VALID_EDGE_PREDICATE,
  walkGraph,
  expandLimitForNode,
} = require('./graph-walk');

function makeEdgeClient(fixture) {
  const calls = [];
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
        const rows = (fixture.out || [])
          .filter((e) => e.source_node_id === sourceId && e._valid !== false)
          .slice(0, limit);
        return { rows };
      }
      if (/FROM memory_edges/i.test(t) && /target_node_id\s*=/i.test(t)) {
        const targetId = params[1];
        const limit = Number(params[2]);
        const rows = (fixture.in || [])
          .filter((e) => e.target_node_id === targetId && e._valid !== false)
          .slice(0, limit);
        return { rows };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

async function main() {
  // fixed M1 limits
  {
    assert.strictEqual(GRAPH_LIMITS.max_depth, 2);
    assert.strictEqual(GRAPH_LIMITS.per_hop_limit, 50);
    assert.strictEqual(GRAPH_LIMITS.max_nodes_total, 100);
    assert.strictEqual(GRAPH_LIMITS.max_edges_total, 200);
    assert.strictEqual(GRAPH_LIMITS.supernode_degree_cap, 64);
  }

  // expandLimit = min(per_hop, supernode cap) — both guards applied
  {
    assert.strictEqual(expandLimitForNode(GRAPH_LIMITS), 50);
    assert.strictEqual(
      expandLimitForNode({ per_hop_limit: 50, supernode_degree_cap: 10 }),
      10
    );
  }

  // valid edge predicate string for hot-path SQL
  {
    assert.match(VALID_EDGE_PREDICATE, /valid_from\s*<=\s*now\(\)/i);
    assert.match(VALID_EDGE_PREDICATE, /valid_until\s+IS\s+NULL/i);
    assert.match(VALID_EDGE_PREDICATE, /valid_until\s*>\s*now\(\)/i);
  }

  // empty seeds → empty walk
  {
    const { client, calls } = makeEdgeClient({ nodes: [] });
    const out = await walkGraph(client, { tenant_id: 't1', seed_item_ids: [] });
    assert.deepStrictEqual(out.mode, 'walk');
    assert.deepStrictEqual(out.candidates, []);
    assert.strictEqual(out.stats.edges_read, 0);
    assert.ok(!calls.some((c) => /memory_edges/i.test(c.text)));
  }

  // 1–2 hop BFS: out+in, visited cycle guard, seed excluded from candidates
  {
    const { client, calls } = makeEdgeClient({
      nodes: [
        { node_id: 'n0', item_id: 'seed' },
        { node_id: 'n1', item_id: 'hop1' },
        { node_id: 'n2', item_id: 'hop2' },
      ],
      out: [
        {
          edge_id: 'e1',
          source_node_id: 'n0',
          target_node_id: 'n1',
          relation_type: 'relates',
          neighbor_item_id: 'hop1',
        },
        // cycle back to seed — must not re-expand
        {
          edge_id: 'e-cycle',
          source_node_id: 'n1',
          target_node_id: 'n0',
          relation_type: 'relates',
          neighbor_item_id: 'seed',
        },
        {
          edge_id: 'e2',
          source_node_id: 'n1',
          target_node_id: 'n2',
          relation_type: 'relates',
          neighbor_item_id: 'hop2',
        },
      ],
      in: [
        {
          edge_id: 'e-in',
          source_node_id: 'n1',
          target_node_id: 'n0',
          relation_type: 'mentions',
          neighbor_item_id: 'hop1',
        },
      ],
    });

    const out = await walkGraph(client, {
      tenant_id: 't1',
      seed_item_ids: ['seed'],
    });
    assert.strictEqual(out.mode, 'walk');
    const ids = out.candidates.map((c) => c.id);
    assert.ok(ids.includes('hop1'));
    assert.ok(ids.includes('hop2'));
    assert.ok(!ids.includes('seed'), 'seeds stay out of graph candidates');
    assert.ok(out.stats.depth_reached >= 1);
    assert.ok(out.stats.depth_reached <= 2);
    assert.ok(calls.some((c) => /source_node_id\s*=/i.test(c.text)));
    assert.ok(calls.some((c) => /target_node_id\s*=/i.test(c.text)));
    assert.ok(calls.every((c) => !/WITH\s+RECURSIVE/i.test(c.text)));
    assert.ok(
      calls
        .filter((c) => /memory_edges/i.test(c.text))
        .every((c) => /valid_from\s*<=\s*now\(\)/i.test(c.text))
    );
  }

  // max_depth=2: depth-3 neighbor not reached
  {
    const { client } = makeEdgeClient({
      nodes: [{ node_id: 'n0', item_id: 's' }],
      out: [
        {
          edge_id: 'e1',
          source_node_id: 'n0',
          target_node_id: 'n1',
          relation_type: 'r',
          neighbor_item_id: 'd1',
        },
        {
          edge_id: 'e2',
          source_node_id: 'n1',
          target_node_id: 'n2',
          relation_type: 'r',
          neighbor_item_id: 'd2',
        },
        {
          edge_id: 'e3',
          source_node_id: 'n2',
          target_node_id: 'n3',
          relation_type: 'r',
          neighbor_item_id: 'd3',
        },
      ],
      in: [],
    });
    // nodes for hop targets need item resolution only for seeds; neighbors come from edge rows
    const out = await walkGraph(client, { tenant_id: 't', seed_item_ids: ['s'] });
    const ids = out.candidates.map((c) => c.id);
    assert.ok(ids.includes('d1'));
    assert.ok(ids.includes('d2'));
    assert.ok(!ids.includes('d3'), 'depth 3 must be cut');
    assert.strictEqual(out.stats.depth_reached, 2);
  }

  // per_hop / supernode cap truncates fan-out
  {
    const many = [];
    for (let i = 0; i < 20; i++) {
      many.push({
        edge_id: `e${i}`,
        source_node_id: 'hub',
        target_node_id: `n${i}`,
        relation_type: 'r',
        neighbor_item_id: `item${i}`,
      });
    }
    const { client } = makeEdgeClient({
      nodes: [{ node_id: 'hub', item_id: 'hub-item' }],
      out: many,
      in: [],
    });
    const out = await walkGraph(client, {
      tenant_id: 't',
      seed_item_ids: ['hub-item'],
      limits: {
        ...GRAPH_LIMITS,
        per_hop_limit: 10,
        supernode_degree_cap: 5,
        max_depth: 1,
      },
    });
    assert.ok(out.candidates.length <= 5);
    assert.strictEqual(out.stats.truncated, true);
  }

  // max_nodes_total / max_edges_total stop early
  {
    const outEdges = [];
    for (let i = 0; i < 30; i++) {
      outEdges.push({
        edge_id: `e${i}`,
        source_node_id: 'n0',
        target_node_id: `n${i + 1}`,
        relation_type: 'r',
        neighbor_item_id: `x${i}`,
      });
    }
    const { client } = makeEdgeClient({
      nodes: [{ node_id: 'n0', item_id: 's' }],
      out: outEdges,
      in: [],
    });
    const out = await walkGraph(client, {
      tenant_id: 't',
      seed_item_ids: ['s'],
      limits: {
        ...GRAPH_LIMITS,
        max_depth: 1,
        per_hop_limit: 50,
        supernode_degree_cap: 64,
        max_nodes_total: 4, // seed + 3
        max_edges_total: 200,
      },
    });
    assert.ok(out.stats.nodes_total <= 4);
    assert.ok(out.candidates.length <= 3);
    assert.strictEqual(out.stats.truncated, true);
  }

  // invalid / expired edges ignored by fixture (_valid false) — SQL must carry predicate
  {
    const { client, calls } = makeEdgeClient({
      nodes: [{ node_id: 'n0', item_id: 's' }],
      out: [
        {
          edge_id: 'bad',
          source_node_id: 'n0',
          target_node_id: 'nx',
          relation_type: 'r',
          neighbor_item_id: 'gone',
          _valid: false,
        },
        {
          edge_id: 'good',
          source_node_id: 'n0',
          target_node_id: 'n1',
          relation_type: 'r',
          neighbor_item_id: 'ok',
        },
      ],
      in: [],
    });
    const out = await walkGraph(client, { tenant_id: 't', seed_item_ids: ['s'] });
    assert.deepStrictEqual(
      out.candidates.map((c) => c.id),
      ['ok']
    );
    assert.ok(
      calls
        .filter((c) => /memory_edges/i.test(c.text))
        .every((c) => VALID_EDGE_PREDICATE.split(/\s+AND\s+/i).every((p) =>
          new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s\+/g, '\\s+'), 'i').test(c.text) ||
          /valid_from|valid_until/i.test(c.text)
        ))
    );
  }

  console.log('OK: graph-walk selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
