-- memory_nodes / memory_edges + RLS + hot-path edge indexes
-- Contract: ARCHITECTURE §1 #5·#15 · §6 DDL · §6.2.4 · Pooler + set_config(..., true)
-- Tickets: fa6351fa (tables+RLS) · 8d3fb9cd (idx out/in + 순회 한도 DESIGN).
-- Non-goals: embeddings/HNSW · TTL job · svc-memory store / graph walk 본구현 (M4).
-- Idempotent for M1 smoke/dev (DROP CASCADE).

BEGIN;

DROP TABLE IF EXISTS memory_edges CASCADE;
DROP TABLE IF EXISTS memory_nodes CASCADE;

CREATE TABLE memory_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  entity_type  TEXT NOT NULL,
  name         TEXT NOT NULL,
  props        JSONB NOT NULL DEFAULT '{}',
  item_id      UUID,  -- logical ref → memory_items.id (no FK; same reason as supersedes_id)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, name)
);

CREATE TABLE memory_edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  source_node_id  UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target_node_id  UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  props           JSONB NOT NULL DEFAULT '{}',
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_node_id <> target_node_id)
);

-- Hot-path valid edges only. valid_until IS NULL = currently valid (or no expiry).
CREATE INDEX idx_memory_edges_out
  ON memory_edges (tenant_id, source_node_id, relation_type)
  WHERE valid_until IS NULL;
CREATE INDEX idx_memory_edges_in
  ON memory_edges (tenant_id, target_node_id, relation_type)
  WHERE valid_until IS NULL;

ALTER TABLE memory_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_edges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_nodes_tenant_isolation ON memory_nodes;
CREATE POLICY memory_nodes_tenant_isolation ON memory_nodes
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS memory_edges_tenant_isolation ON memory_edges;
CREATE POLICY memory_edges_tenant_isolation ON memory_edges
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
