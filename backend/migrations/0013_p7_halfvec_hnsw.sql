DROP INDEX IF EXISTS idx_embeddings_hnsw;

ALTER TABLE embeddings
    ALTER COLUMN embedding TYPE halfvec(1536) USING embedding::halfvec(1536);

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
    ON embeddings USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_article
    ON embeddings USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE owner_type = 'article';
