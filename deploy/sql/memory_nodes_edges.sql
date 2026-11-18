-- memory_nodes / memory_edges + RLS
-- Contract: ARCHITECTURE §1 #5 · §6 DDL · Pooler + set_config(..., true)
-- Ticket: fa6351fa. Non-goals: edge partial indexes + 순회 한도 DESIGN (별도) · embeddings/HNSW · TTL job · svc-memory store body.
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
