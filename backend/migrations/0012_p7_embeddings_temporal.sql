ALTER TABLE articles DROP COLUMN IF EXISTS embedding;
ALTER TABLE ontology_nodes DROP COLUMN IF EXISTS embedding;

ALTER TABLE ontology_edges
    ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confidence FLOAT NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS source_conversation_id UUID;

ALTER TABLE ontology_edges DROP CONSTRAINT IF EXISTS uq_edge;
CREATE UNIQUE INDEX IF NOT EXISTS uq_edge_current
    ON ontology_edges (account_id, source_node_id, target_node_id, relation_type)
    WHERE valid_until IS NULL;

CREATE TABLE IF NOT EXISTS embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    owner_type VARCHAR(50) NOT NULL,
    owner_id UUID NOT NULL,
    model VARCHAR(100) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    embedding vector(1536) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_embedding_owner_model UNIQUE (account_id, owner_type, owner_id, model, version)
);

ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS embeddings_tenant ON embeddings;
CREATE POLICY embeddings_tenant ON embeddings
    USING (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid))
    WITH CHECK (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON embeddings TO aura_app;

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_ontology_edges_valid ON ontology_edges (account_id, source_node_id, relation_type)
    WHERE valid_until IS NULL;
