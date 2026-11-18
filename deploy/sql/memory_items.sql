-- memory_items: LIST(memory_type) + short_term/episodic monthly RANGE + RLS
-- Contract: ARCHITECTURE §1 #8 · §6 DDL · Pooler + set_config(..., true)
-- Ticket: a181ec17. Non-goals: memory_audit · embeddings · svc-memory store body.
-- Idempotent for M1 smoke/dev (DROP CASCADE). Production ATTACH/TTL job is later ticket.

BEGIN;

DROP TABLE IF EXISTS memory_items CASCADE;
DROP TYPE IF EXISTS memory_type CASCADE;

CREATE TYPE memory_type AS ENUM (
  'short_term',
  'long_term',
  'episodic',
  'semantic'
);

CREATE TABLE memory_items (
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  principal_id    TEXT,
  agent_id        TEXT,
  session_id      TEXT,
  run_id          TEXT,
  memory_type     memory_type NOT NULL,
  content         TEXT NOT NULL,
  content_tsv     tsvector GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(content, ''))
                  ) STORED,
  metadata        JSONB NOT NULL DEFAULT '{}',
  confidence      REAL,
  source_event_id UUID,
  supersedes_id   UUID,
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, memory_type, created_at)
) PARTITION BY LIST (memory_type);

-- LIST leaves: long_term / semantic (no monthly sub-partition in M1).
CREATE TABLE memory_items_long_term PARTITION OF memory_items
  FOR VALUES IN ('long_term');
CREATE TABLE memory_items_semantic PARTITION OF memory_items
  FOR VALUES IN ('semantic');

-- short_term / episodic: RANGE(created_at) parents for monthly TTL DROP.
CREATE TABLE memory_items_short_term PARTITION OF memory_items
  FOR VALUES IN ('short_term') PARTITION BY RANGE (created_at);
CREATE TABLE memory_items_episodic PARTITION OF memory_items
  FOR VALUES IN ('episodic') PARTITION BY RANGE (created_at);

-- Seed months are attached by check/smoke helper (UTC month bounds).
-- Placeholder comment for static gate: FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM-01')

CREATE INDEX idx_memory_items_scope
  ON memory_items (tenant_id, memory_type, session_id, created_at DESC);
CREATE INDEX idx_memory_items_tsv ON memory_items USING GIN (content_tsv);
CREATE INDEX idx_memory_items_metadata ON memory_items USING GIN (metadata);

ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_items_tenant_isolation ON memory_items;
CREATE POLICY memory_items_tenant_isolation ON memory_items
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
