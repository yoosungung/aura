DROP INDEX IF EXISTS idx_embeddings_hnsw;
DROP INDEX IF EXISTS idx_embeddings_hnsw_article;

ALTER TABLE embeddings
    ALTER COLUMN embedding TYPE halfvec USING embedding::halfvec;

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_1536
    ON embeddings USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE vector_dims(embedding) = 1536;

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_768
    ON embeddings USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE vector_dims(embedding) = 768;

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_article_1536
    ON embeddings USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE owner_type = 'article' AND vector_dims(embedding) = 1536;

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_article_768
    ON embeddings USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE owner_type = 'article' AND vector_dims(embedding) = 768;
