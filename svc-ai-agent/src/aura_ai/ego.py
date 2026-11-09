from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from aura_ai.hours import open_now

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


async def read_ego(conn, contact_id: str) -> list[dict]:
    rows = await (await conn.execute(EGO_SQL, (contact_id,))).fetchall()
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


async def customer_node_id(conn, contact_id: str) -> str | None:
    row = await (
        await conn.execute(
            """
            SELECT id FROM ontology_nodes
            WHERE entity_type = 'Customer' AND external_ref_id = %s
            LIMIT 1
            """,
            (contact_id,),
        )
    ).fetchone()
    return str(row[0]) if row else None


async def read_messages(conn, conversation_id: str) -> str:
    rows = await (
        await conn.execute(
            "SELECT content FROM messages WHERE conversation_id = %s ORDER BY created_at",
            (conversation_id,),
        )
    ).fetchall()
    return "\n".join(str(r[0] or "") for r in rows)


async def read_article(conn, article_id: str) -> str:
    row = await (
        await conn.execute(
            "SELECT COALESCE(title, '') || ' ' || COALESCE(body, '') FROM articles WHERE id = %s",
            (article_id,),
        )
    ).fetchone()
    return str(row[0]) if row else ""


MAX_EMBED_DIM = 4000
HNSW_DIMS = (768, 1536)


def halfvec_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in vector) + "]"


async def search_articles(
    conn,
    vector: list[float],
    model: str | None = None,
    version: int = 1,
) -> list[dict]:
    dim = len(vector)
    if dim < 1 or dim > MAX_EMBED_DIM:
        return []
    model = model or os.environ.get("AURA_EMBEDDING_MODEL", "text-embedding-3-small")
    lit = halfvec_literal(vector)
    if dim in HNSW_DIMS:
        dist = f"e.embedding::halfvec({dim}) <=> %s::halfvec({dim})"
    else:
        dist = "e.embedding <=> %s::halfvec"
    await conn.execute("SET LOCAL hnsw.ef_search = 40")
    await conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
    rows = await (
        await conn.execute(
            f"""
            SELECT a.id, a.title, left(a.body, 500), e.model, e.version
            FROM embeddings e
            JOIN articles a ON a.id = e.owner_id AND a.account_id = e.account_id
            WHERE e.owner_type = 'article'
              AND e.model = %s
              AND e.version = %s
              AND vector_dims(e.embedding) = %s
              AND a.published
            ORDER BY {dist}
            LIMIT 5
            """,
            (model, version, dim, lit),
        )
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


async def staff_available(conn, inbox_id: str, now: datetime | None = None) -> bool:
    row = await (
        await conn.execute(
            """
            SELECT business_hours_enabled, business_hours
            FROM inboxes WHERE id = %s
            """,
            (inbox_id,),
        )
    ).fetchone()
    if not row:
        return False
    enabled, hours = bool(row[0]), row[1]
    if not open_now(now or datetime.now(timezone.utc), enabled, hours):
        return False
    online = await (
        await conn.execute(
            """
            SELECT COUNT(*) FROM inbox_members m
            JOIN users u ON u.id = m.user_id
            WHERE m.inbox_id = %s AND u.availability_status = 'online'
            """,
            (inbox_id,),
        )
    ).fetchone()
    return int((online or [0])[0] or 0) > 0


def bind_agent(agent, pool) -> None:
    async def with_account(account_id: str, fn: Callable[[Any], Awaitable[Any]]):
        async with pool.connection() as conn:
            async with conn.transaction():
                await conn.execute("SELECT set_config('app.current_account_id', %s, true)", (account_id,))
                return await fn(conn)

    async def read_ego_bound(account: str, contact: str) -> list[dict]:
        return await with_account(account, lambda conn: read_ego(conn, contact))

    async def read_center_bound(account: str, contact: str) -> str | None:
        return await with_account(account, lambda conn: customer_node_id(conn, contact))

    async def read_messages_bound(account: str, conv: str) -> str:
        return await with_account(account, lambda conn: read_messages(conn, conv))

    async def read_article_bound(account: str, article: str) -> str:
        return await with_account(account, lambda conn: read_article(conn, article))

    async def read_rag_bound(account: str, vec: list[float]) -> list[dict]:
        return await with_account(account, lambda conn: search_articles(conn, vec))

    async def read_skills_bound(account: str) -> list[dict]:
        return await with_account(account, lambda conn: list_agent_skills(conn))

    async def read_mcp_servers_bound(account: str) -> list[dict]:
        return await with_account(account, lambda conn: list_mcp_servers(conn))

    async def read_staff_available_bound(account: str, inbox: str) -> bool:
        return await with_account(account, lambda conn: staff_available(conn, inbox))

    agent.read_ego = read_ego_bound
    agent.read_center = read_center_bound
    agent.read_messages = read_messages_bound
    agent.read_article = read_article_bound
    agent.read_rag = read_rag_bound
    agent.read_skills = read_skills_bound
    agent.read_mcp_servers = read_mcp_servers_bound
    agent.read_staff_available = read_staff_available_bound


async def list_agent_skills(conn) -> list[dict]:
    try:
        rows = await (
            await conn.execute(
                "SELECT name, description, body, enabled FROM agent_skills WHERE enabled ORDER BY name"
            )
        ).fetchall()
    except Exception:
        return []
    return [
        {"name": r[0], "description": r[1] or "", "body": r[2] or "", "enabled": r[3]}
        for r in rows
    ]


async def list_mcp_servers(conn) -> list[dict]:
    try:
        rows = await (
            await conn.execute(
                """
                SELECT name, url, auth_header, allowed_tools, high_risk_tools, enabled
                FROM mcp_servers WHERE enabled ORDER BY name
                """
            )
        ).fetchall()
    except Exception:
        return []
    return [
        {
            "name": r[0],
            "url": r[1],
            "auth_header": r[2] or "",
            "allowed_tools": list(r[3] or []),
            "high_risk_tools": list(r[4] or []),
            "enabled": r[5],
        }
        for r in rows
    ]
