'use strict';

const assert = require('assert');
const {
  recallOnce,
  parseRequest,
  fuseRrf,
  poolerHostOk,
  SUBJECT,
} = require('./handler');

function fakeClient(rowsByKind) {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      const t = String(text);
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [] };
      if (/set_config\('app\.tenant_id'/.test(t)) return { rows: [{ set_config: params[0] }] };
      if (/SET LOCAL hnsw\./i.test(t)) return { rows: [] };
      if (/memory_type\s*=\s*'short_term'|memory_type\s*=\s*\$/.test(t) && /ORDER BY created_at DESC/i.test(t)) {
        return { rows: rowsByKind.short_term || [] };
      }
      if (/content_tsv|ts_rank|plainto_tsquery/i.test(t)) {
        return { rows: rowsByKind.bm25 || [] };
      }
      if (/halfvec|<=>|memory_embeddings/i.test(t)) {
        return { rows: rowsByKind.vector || [] };
      }
      if (/FROM memory_nodes/i.test(t) && /item_id/i.test(t)) {
        return { rows: rowsByKind.graph_nodes || [] };
      }
      if (/FROM memory_edges/i.test(t)) {
        return { rows: rowsByKind.graph_edges || [] };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

async function main() {
  // missing tenant_id → 400
  {
    const res = await recallOnce({ query: 'hello', top_k: 3 });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'tenant_id_required');
  }

  // missing query → 400
  {
    const res = await recallOnce({ tenant_id: 'tenant-a', top_k: 3 });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'query_required');
  }

  // fuseRrf: reciprocal ranks (k=60)
  {
    const fused = fuseRrf(
      [
        [{ id: 'a' }, { id: 'b' }],
        [{ id: 'b' }, { id: 'c' }],
      ],
      { k: 60, weights: [1, 1] }
    );
    assert.strictEqual(fused[0].id, 'b');
    assert.ok(fused[0].rrf_score > fused[1].rrf_score);
    assert.strictEqual(fused.length, 3);
  }

  // happy path: short_term recent + BM25/vector RRF + graph walk; GUCs + tenant WHERE
  {
    const { client, calls } = fakeClient({
      short_term: [
        {
          id: 'st-1',
          memory_type: 'short_term',
          content: 'session note',
          created_at: '2026-11-19T00:00:00Z',
          session_id: 'sess-1',
        },
      ],
      bm25: [
        { id: 'ep-1', memory_type: 'episodic', content: 'bm25 hit', rank: 1 },
        { id: 'lt-1', memory_type: 'long_term', content: 'bm25 second', rank: 2 },
      ],
      vector: [
        { id: 'lt-1', memory_type: 'long_term', content: 'vec hit', rank: 1 },
        { id: 'sem-1', memory_type: 'semantic', content: 'vec second', rank: 2 },
      ],
      graph_nodes: [{ node_id: 'n-ep', item_id: 'ep-1' }],
      graph_edges: [
        {
          edge_id: 'e1',
          source_node_id: 'n-ep',
          target_node_id: 'n-g',
          relation_type: 'relates',
          neighbor_item_id: 'graph-1',
        },
      ],
    });

    const req = {
      tenant_id: 'tenant-a',
      principal_id: 'user-1',
      session_id: 'sess-1',
      query: 'recent notes',
      query_embedding: Array(8).fill(0.1),
      types: ['short_term', 'episodic', 'long_term', 'semantic'],
      top_k: 12,
    };
    const res = await recallOnce(req, { pgClient: client });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'memory.recall.done');
    assert.strictEqual(body.mode, 'hybrid_rrf');
    assert.strictEqual(body.subject, SUBJECT);
    assert.strictEqual(body.deploy_class, 'sync');
    assert.strictEqual(body.tenant_id, 'tenant-a');
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.some((it) => it.id === 'st-1' && it.memory_type === 'short_term'));
    assert.ok(body.items.some((it) => it.id === 'lt-1'), 'RRF should surface id in both branches');
    assert.strictEqual(body.graph.mode, 'walk');
    assert.ok(Array.isArray(body.graph.candidates));
    assert.ok(body.graph.candidates.some((c) => c.id === 'graph-1'));
    assert.deepStrictEqual(body.rrf.branches, ['bm25', 'vector', 'graph']);

    const texts = calls.map((c) => c.text);
    assert.strictEqual(texts[0], 'BEGIN');
    assert.ok(/set_config\('app\.tenant_id',\s*\$1,\s*true\)/.test(texts[1]));
    assert.deepStrictEqual(calls[1].params, ['tenant-a']);
    assert.ok(texts.some((t) => /SET LOCAL hnsw\.iterative_scan\s*=\s*relaxed_order/i.test(t)));
    assert.ok(texts.some((t) => /SET LOCAL hnsw\.ef_search\s*=\s*40/i.test(t)));
    assert.ok(texts.some((t) => /SET LOCAL hnsw\.max_scan_tuples\s*=\s*20000/i.test(t)));

    const shortSql = calls.find((c) => /ORDER BY created_at DESC/i.test(c.text));
    assert.ok(shortSql, 'short_term recent SELECT required');
    assert.ok(/tenant_id/i.test(shortSql.text));
    assert.ok(/short_term/i.test(shortSql.text));
    assert.ok(!/halfvec|<=>|hnsw/i.test(shortSql.text), 'short_term must not use HNSW');

    const bm25Sql = calls.find((c) => /ts_rank|content_tsv/i.test(c.text));
    assert.ok(bm25Sql, 'BM25 SELECT required');
    assert.ok(/tenant_id\s*=\s*\$/i.test(bm25Sql.text));

    const vecSql = calls.find((c) => /halfvec|<=>/i.test(c.text));
    assert.ok(vecSql, 'vector SELECT required when query_embedding present');
    assert.ok(/tenant_id\s*=\s*\$/i.test(vecSql.text), 'tenant WHERE must be in same vector SQL');
    assert.ok(/model_key/i.test(vecSql.text));
    assert.ok(/iterative_scan|ef_search|SET LOCAL/i.test(texts.join('\n')));

    assert.ok(texts.some((t) => /FROM memory_nodes/i.test(t)), 'graph seed resolve');
    assert.ok(texts.some((t) => /FROM memory_edges/i.test(t) && /valid_from/i.test(t)));
    assert.ok(!texts.some((t) => /WITH\s+RECURSIVE/i.test(t)));

    assert.strictEqual(texts[texts.length - 1], 'COMMIT');
  }

  // without query_embedding → BM25 + short_term only (vector skipped; TEI non-goal)
  {
    const { client, calls } = fakeClient({
      short_term: [],
      bm25: [{ id: 'ep-2', memory_type: 'episodic', content: 'only bm25', rank: 1 }],
      vector: [{ id: 'should-not', memory_type: 'semantic', content: 'x', rank: 1 }],
    });
    const res = await recallOnce(
      { tenant_id: 't1', query: 'q', top_k: 5, types: ['episodic', 'semantic'] },
      { pgClient: client }
    );
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.mode, 'hybrid_rrf');
    assert.ok(body.items.some((it) => it.id === 'ep-2'));
    assert.ok(!calls.some((c) => /halfvec|<=>/i.test(c.text)), 'vector SQL skipped without embedding');
  }

  // pooler host contract
  {
    assert.strictEqual(poolerHostOk('aura-pg-pooler.aura.svc.cluster.local'), true);
    assert.strictEqual(poolerHostOk('aura-pg-pooler-ro.aura.svc.cluster.local'), true);
    assert.strictEqual(poolerHostOk('aura-pg-rw.aura.svc.cluster.local'), false);
    assert.strictEqual(poolerHostOk('10.0.0.1'), false);
  }

  // parseRequest: Core RR raw string / buffer / object
  {
    assert.deepStrictEqual(parseRequest('{"tenant_id":"t","query":"q"}'), {
      tenant_id: 't',
      query: 'q',
    });
    assert.deepStrictEqual(parseRequest(Buffer.from('{"tenant_id":"t2","query":"q2"}')), {
      tenant_id: 't2',
      query: 'q2',
    });
    assert.deepStrictEqual(parseRequest({ tenant_id: 't3', query: 'q3' }), {
      tenant_id: 't3',
      query: 'q3',
    });
  }

  console.log('OK: recall hybrid RRF + graph walk selftest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
