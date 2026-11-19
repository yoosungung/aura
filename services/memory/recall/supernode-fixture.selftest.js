'use strict';

const assert = require('assert');
const { walkGraph, GRAPH_LIMITS, expandLimitForNode } = require('./graph-walk');
const {
  HUB_DEGREE,
  buildSupernodeFixture,
  makeSupernodeClient,
  probeUncappedHubDegree,
} = require('./supernode-fixture');

async function main() {
  const expandCap = expandLimitForNode(GRAPH_LIMITS);
  assert.ok(HUB_DEGREE > GRAPH_LIMITS.supernode_degree_cap);
  assert.ok(HUB_DEGREE > GRAPH_LIMITS.per_hop_limit);
  assert.strictEqual(expandCap, 50);

  const fixture = buildSupernodeFixture();
  assert.strictEqual(fixture.hub_degree, HUB_DEGREE);
  assert.strictEqual(fixture.out.length, HUB_DEGREE);

  // OFF contrast: uncapped read would return full hub degree (explosion)
  {
    const off = probeUncappedHubDegree(fixture);
    assert.strictEqual(off, HUB_DEGREE);
  }

  // ON: defensive walk respects query LIMIT + return caps (no explosion)
  {
    const { client, stats } = makeSupernodeClient(fixture);
    const t0 = Date.now();
    const out = await walkGraph(client, {
      tenant_id: fixture.tenant_id,
      seed_item_ids: ['hub-item'],
      limits: { ...GRAPH_LIMITS, max_depth: 1 },
    });
    const ms = Date.now() - t0;
    const s = stats();

    assert.strictEqual(out.mode, 'walk');
    assert.ok(out.candidates.length <= expandCap, `candidates ${out.candidates.length} > cap ${expandCap}`);
    assert.strictEqual(out.stats.truncated, true);
    assert.ok(out.stats.edges_read <= expandCap * 2, 'edges_read must stay near per-node cap');
    assert.ok(s.max_limit_param <= expandCap, `LIMIT param ${s.max_limit_param} must be ≤ expandCap`);
    assert.ok(s.rows_returned <= expandCap * 2, `rows_returned ${s.rows_returned} exploded`);
    assert.ok(s.rows_returned < HUB_DEGREE, 'must not materialize full hub adjacency');
    assert.ok(s.edge_query_n <= 4, `edge queries ${s.edge_query_n} suggest unbounded fan-out`);
    assert.ok(ms < 2000, `wall clock ${ms}ms suggests hang`);
  }

  // depth-2 still bounded under hub + spoke fan-out
  {
    const { client, stats } = makeSupernodeClient(fixture);
    const out = await walkGraph(client, {
      tenant_id: fixture.tenant_id,
      seed_item_ids: ['hub-item'],
      limits: GRAPH_LIMITS,
    });
    const s = stats();
    assert.ok(out.stats.depth_reached <= 2);
    assert.ok(out.stats.nodes_total <= GRAPH_LIMITS.max_nodes_total);
    assert.ok(out.stats.edges_read <= GRAPH_LIMITS.max_edges_total);
    assert.ok(out.candidates.length <= GRAPH_LIMITS.max_nodes_total);
    assert.ok(s.rows_returned <= GRAPH_LIMITS.max_edges_total);
    assert.ok(s.rows_returned < HUB_DEGREE * 2, 'depth-2 must not fetch hub_degree twice unbounded');
  }

  console.log('OK: supernode fixture selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
