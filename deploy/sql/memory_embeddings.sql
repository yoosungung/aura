-- memory_embeddings: LIST(model_key) + partition-local halfvec(N) HNSW + RLS
-- Contract: ARCHITECTURE §1 #3·#14 · §6 DDL · §6.2.1 · Pooler + set_config(..., true)
-- Ticket: 0d7a4200 (+ 6dfc4c4a short_term CHECK / iterative_scan DESIGN).
-- Non-goals: production AURA_EMBEDDING_* 실값 · HNSW 왜곡 픽스처 · svc-memory store.
-- Generation: deploy/docs/memory-embeddings-generation.md
-- Guards: deploy/docs/memory-embed-guard-iterative-scan.md
-- Idempotent for M1 smoke/dev (DROP CASCADE). Production ATTACH uses runbook + env dims.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- memory_type may already exist from memory_items.sql.
DO $$ BEGIN
  CREATE TYPE memory_type AS ENUM (
    'short_term',
    'long_term',
    'episodic',
    'semantic'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DROP TABLE IF EXISTS memory_embeddings CASCADE;

-- Parent: undimensioned halfvec. Never CREATE INDEX ... hnsw(embedding) here.
CREATE TABLE memory_embeddings (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  item_id      UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  memory_type  memory_type NOT NULL
                 CHECK (memory_type IN ('episodic', 'long_term', 'semantic')),
  model        TEXT NOT NULL,
  version      TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  dims         INT NOT NULL CHECK (dims > 0 AND dims <= 4000),
  embedding    halfvec NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, model_key),
  UNIQUE (item_id, model_key),
  CHECK (model_key = model || ':' || version)
) PARTITION BY LIST (model_key);

-- No production model_key leaf in this file.
-- Attach example (fixture / ops): see memory-embeddings-generation.md
--   CREATE TABLE memory_embeddings_p_<slug> PARTITION OF memory_embeddings
--     FOR VALUES IN ('<model>:<version>');
--   ALTER TABLE ... ADD CONSTRAINT ... CHECK (dims = <N>);
--   CREATE INDEX ... USING hnsw ((embedding::halfvec(<N>)) halfvec_cosine_ops);

ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_embeddings_tenant_isolation ON memory_embeddings;
CREATE POLICY memory_embeddings_tenant_isolation ON memory_embeddings
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
