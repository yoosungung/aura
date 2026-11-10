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


async def read_message_rows(conn, conversation_id: str) -> list[dict]:
    rows = await (
        await conn.execute(
            """
            SELECT id, content, private, sender_type, created_at
            FROM messages
            WHERE conversation_id = %s
            ORDER BY created_at
            """,
            (conversation_id,),
        )
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": str(r[0]),
                "content": str(r[1] or ""),
                "private": bool(r[2]),
                "sender_type": str(r[3] or ""),
                "created_at": str(r[4] or ""),
            }
        )
    return out


async def read_messages(conn, conversation_id: str) -> str:
    from aura_ai.memory import public_l0, transcript_from_l0

    rows = await read_message_rows(conn, conversation_id)
    return transcript_from_l0(public_l0(rows))


async def drill_edges(conn, relation_type: str, source_id: str | None = None, target_id: str | None = None) -> list[dict]:
    clauses = [
        "account_id = current_setting('app.current_account_id')::uuid",
        "relation_type = %s",
        "valid_from <= CURRENT_TIMESTAMP",
        "(valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)",
    ]
    args: list[Any] = [relation_type]
    if source_id:
        clauses.append("source_node_id = %s")
        args.append(source_id)
    if target_id:
        clauses.append("target_node_id = %s")
        args.append(target_id)
    rows = await (
        await conn.execute(
            f"""
            SELECT id, source_node_id, target_node_id, relation_type, valid_until
            FROM ontology_edges
            WHERE {' AND '.join(clauses)}
            """,
            tuple(args),
        )
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "source_node_id": str(r[1]),
            "target_node_id": str(r[2]),
            "relation_type": r[3],
            "valid_until": r[4],
        }
        for r in rows
    ]


async def read_nodes_by_ids(conn, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = await (
        await conn.execute(
            """
            SELECT id, entity_type, name, properties
            FROM ontology_nodes
            WHERE id = ANY(%s::uuid[])
            """,
            (ids,),
        )
    ).fetchall()
    out = {}
    for r in rows:
        out[str(r[0])] = {
            "id": str(r[0]),
            "entity_type": r[1],
            "name": r[2],
            "properties": r[3] or {},
        }
    return out


async def messages_by_ids(conn, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = await (
        await conn.execute(
            """
            SELECT id, content, private, sender_type, created_at
            FROM messages
            WHERE id = ANY(%s::uuid[]) AND NOT private
            """,
            (ids,),
        )
    ).fetchall()
    return {
        str(r[0]): {
            "id": str(r[0]),
            "content": str(r[1] or ""),
            "sender_type": str(r[3] or ""),
            "created_at": str(r[4] or ""),
        }
        for r in rows
    }


async def customer_persona(conn, contact_id: str) -> dict:
    row = await (
        await conn.execute(
            """
            SELECT id, name, properties FROM ontology_nodes
            WHERE entity_type = 'Customer' AND external_ref_id = %s
            LIMIT 1
            """,
            (contact_id,),
        )
    ).fetchone()
    if not row:
        return {"id": None, "summary": "", "name": ""}
    props = row[2] or {}
    return {"id": str(row[0]), "name": row[1], "summary": str(props.get("summary") or "")}


async def search_l1_nodes(conn, query: str, limit: int = 5) -> list[dict]:
    rows = await (
        await conn.execute(
            """
            SELECT id, entity_type, name, properties
            FROM ontology_nodes
            WHERE entity_type = ANY(%s)
              AND (name ILIKE %s OR properties::text ILIKE %s)
            ORDER BY updated_at DESC
            LIMIT %s
            """,
            (list({"PainPoint", "Preference", "Product", "Feature"}), f"%{query}%", f"%{query}%", limit),
        )
    ).fetchall()
    return [
        {"id": str(r[0]), "entity_type": r[1], "name": r[2], "properties": r[3] or {}, "layer": "L1"}
        for r in rows
    ]


async def search_l0_messages(conn, conversation_id: str, query: str, limit: int = 5) -> list[dict]:
    rows = await (
        await conn.execute(
            """
            SELECT id, content, sender_type, created_at
            FROM messages
            WHERE conversation_id = %s AND NOT private AND content ILIKE %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (conversation_id, f"%{query}%", limit),
        )
    ).fetchall()
    return [
        {"id": str(r[0]), "content": str(r[1] or ""), "sender_type": str(r[2] or ""), "created_at": str(r[3] or ""), "layer": "L0"}
        for r in rows
    ]


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


def bind_handler(handler, pool) -> None:
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

    async def read_l0_bound(account: str, conv: str) -> list[dict]:
        from aura_ai.memory import public_l0

        rows = await with_account(account, lambda conn: read_message_rows(conn, conv))
        return public_l0(rows)

    async def read_persona_bound(account: str, contact: str) -> dict:
        return await with_account(account, lambda conn: customer_persona(conn, contact))

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

    async def memory_drill_down_bound(account: str, from_layer: str, ref_id: str) -> dict:
        from aura_ai.memory import LAYER_L1, LAYER_L2, LAYER_L3, drill_down_graph

        async def run(conn):
            layer = (from_layer or "").upper()
            if layer == LAYER_L3:
                edges = await drill_edges(conn, "HAS_SCENARIO", source_id=ref_id)
                nodes = await read_nodes_by_ids(conn, [e["target_node_id"] for e in edges])
                return drill_down_graph(layer, ref_id, edges=edges, nodes=nodes)
            if layer == LAYER_L2:
                edges = await drill_edges(conn, "CONTAINS_ATOM", source_id=ref_id)
                nodes = await read_nodes_by_ids(conn, [e["target_node_id"] for e in edges])
                return drill_down_graph(layer, ref_id, edges=edges, nodes=nodes)
            if layer == LAYER_L1:
                nodes = await read_nodes_by_ids(conn, [ref_id])
                props = (nodes.get(ref_id) or {}).get("properties") or {}
                mids = [str(x) for x in (props.get("source_message_ids") or [])]
                messages = await messages_by_ids(conn, mids)
                return drill_down_graph(layer, ref_id, edges=[], nodes=nodes, messages=messages)
            return {"miss": True, "reason": "layer", "items": []}

        return await with_account(account, run)

    async def memory_drill_up_bound(account: str, from_layer: str, ref_id: str) -> dict:
        from aura_ai.memory import LAYER_L0, LAYER_L1, LAYER_L2, drill_up_graph

        async def run(conn):
            layer = (from_layer or "").upper()
            if layer == LAYER_L0:
                rows = await (
                    await conn.execute(
                        """
                        SELECT id, entity_type, name, properties
                        FROM ontology_nodes
                        WHERE properties -> 'source_message_ids' ? %s
                        LIMIT 20
                        """,
                        (ref_id,),
                    )
                ).fetchall()
                nodes = {
                    str(r[0]): {"id": str(r[0]), "entity_type": r[1], "name": r[2], "properties": r[3] or {}}
                    for r in rows
                }
                return drill_up_graph(layer, ref_id, edges=[], nodes=nodes)
            if layer == LAYER_L1:
                edges = await drill_edges(conn, "CONTAINS_ATOM", target_id=ref_id)
                nodes = await read_nodes_by_ids(conn, [e["source_node_id"] for e in edges])
                return drill_up_graph(layer, ref_id, edges=edges, nodes=nodes)
            if layer == LAYER_L2:
                edges = await drill_edges(conn, "HAS_SCENARIO", target_id=ref_id)
                nodes = await read_nodes_by_ids(conn, [e["source_node_id"] for e in edges])
                return drill_up_graph(layer, ref_id, edges=edges, nodes=nodes)
            return {"miss": True, "reason": "layer", "items": []}

        return await with_account(account, run)

    async def memory_search_bound(account: str, conversation_id: str, layer: str, query: str) -> dict:
        async def run(conn):
            ly = (layer or "").upper()
            if ly == "L1":
                return {"items": await search_l1_nodes(conn, query)}
            if ly == "L0":
                return {"items": await search_l0_messages(conn, conversation_id, query)}
            return {"miss": True, "reason": "layer", "items": []}

        return await with_account(account, run)

    handler.read_ego = read_ego_bound
    handler.read_center = read_center_bound
    handler.read_messages = read_messages_bound
    handler.read_l0 = read_l0_bound
    handler.read_persona = read_persona_bound
    handler.read_article = read_article_bound
    handler.read_rag = read_rag_bound
    handler.read_skills = read_skills_bound
    handler.read_mcp_servers = read_mcp_servers_bound
    handler.read_staff_available = read_staff_available_bound
    handler.memory_drill_down = memory_drill_down_bound
    handler.memory_drill_up = memory_drill_up_bound
    handler.memory_search = memory_search_bound


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
