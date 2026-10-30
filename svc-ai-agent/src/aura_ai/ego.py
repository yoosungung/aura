from __future__ import annotations

EGO_SQL = """
WITH center AS (
  SELECT id FROM ontology_nodes
  WHERE account_id = current_setting('app.current_account_id')::uuid
    AND entity_type = 'Customer'
    AND external_ref_id = %s
),
hop1 AS (
  SELECT e.target_node_id AS node_id, e.relation_type, e.weight, 1 AS hop
  FROM ontology_edges e
  JOIN center c ON e.source_node_id = c.id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND e.valid_from <= CURRENT_TIMESTAMP
    AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
  UNION ALL
  SELECT e.source_node_id, e.relation_type, e.weight, 1
  FROM ontology_edges e
  JOIN center c ON e.target_node_id = c.id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND e.valid_from <= CURRENT_TIMESTAMP
    AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
),
hop2 AS (
  SELECT e.target_node_id AS node_id, e.relation_type, e.weight, 2 AS hop
  FROM ontology_edges e
  JOIN hop1 h ON e.source_node_id = h.node_id
  JOIN ontology_nodes n ON n.id = e.target_node_id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND h.hop = 1
    AND n.entity_type <> 'Customer'
    AND e.valid_from <= CURRENT_TIMESTAMP
    AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
)
SELECT n.id, n.entity_type, n.name, n.properties, x.relation_type, x.hop
FROM (
  SELECT * FROM hop1
  UNION
  SELECT * FROM hop2
) x
JOIN ontology_nodes n ON n.id = x.node_id
ORDER BY x.hop ASC, x.weight DESC, n.updated_at DESC
LIMIT 50
"""


def read_ego(conn, contact_id: str) -> list[dict]:
    rows = conn.execute(EGO_SQL, (contact_id,)).fetchall()
    out = []
    for row in rows:
        out.append(
            {
                "id": str(row[0]),
                "entity_type": row[1],
                "name": row[2],
                "properties": row[3] or {},
                "relation_type": row[4],
                "hop": row[5],
            }
        )
    return out


def customer_node_id(conn, contact_id: str) -> str | None:
    row = conn.execute(
        """
        SELECT id FROM ontology_nodes
        WHERE entity_type = 'Customer' AND external_ref_id = %s
        LIMIT 1
        """,
        (contact_id,),
    ).fetchone()
    return str(row[0]) if row else None


def read_messages(conn, conversation_id: str) -> str:
    rows = conn.execute(
        "SELECT content FROM messages WHERE conversation_id = %s ORDER BY created_at",
        (conversation_id,),
    ).fetchall()
    return "\n".join(str(r[0] or "") for r in rows)


def read_article(conn, article_id: str) -> str:
    row = conn.execute(
        "SELECT COALESCE(title, '') || ' ' || COALESCE(body, '') FROM articles WHERE id = %s",
        (article_id,),
    ).fetchone()
    return str(row[0]) if row else ""


def halfvec_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in vector) + "]"


def search_articles(
    conn,
    vector: list[float],
    model: str = "text-embedding-3-small",
    version: int = 1,
) -> list[dict]:
    conn.execute("SET LOCAL hnsw.ef_search = 40")
    conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
    rows = conn.execute(
        """
        SELECT a.id, a.title, left(a.body, 500), e.model, e.version
        FROM embeddings e
        JOIN articles a ON a.id = e.owner_id AND a.account_id = e.account_id
        WHERE e.owner_type = 'article'
          AND e.model = %s
          AND e.version = %s
          AND a.published
        ORDER BY e.embedding <=> %s::halfvec
        LIMIT 5
        """,
        (model, version, halfvec_literal(vector)),
    ).fetchall()
    out = []
    for row in rows:
        out.append(
            {
                "id": str(row[0]),
                "title": row[1],
                "body": row[2],
                "model": row[3],
                "version": row[4],
            }
        )
    return out


def bind_agent(agent, conn) -> None:
    def with_account(account_id: str, fn):
        with conn.transaction():
            conn.execute("SELECT set_config('app.current_account_id', %s, true)", (account_id,))
            return fn()

    agent.read_ego = lambda account, contact: with_account(account, lambda: read_ego(conn, contact))
    agent.read_center = lambda account, contact: with_account(account, lambda: customer_node_id(conn, contact))
    agent.read_messages = lambda account, conv: with_account(account, lambda: read_messages(conn, conv))
    agent.read_article = lambda account, article: with_account(account, lambda: read_article(conn, article))
    agent.read_rag = lambda account, vec: with_account(account, lambda: search_articles(conn, vec))
