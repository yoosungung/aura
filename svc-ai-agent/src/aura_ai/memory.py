from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

ATOM_TYPES = frozenset({"PainPoint", "Preference", "Product", "Feature"})
LAYER_L0 = "L0"
LAYER_L1 = "L1"
LAYER_L2 = "L2"
LAYER_L3 = "L3"


def public_l0(rows: list[dict]) -> list[dict]:
    """L0 evidence: public messages only, with stable ids for GROUNDED_IN refs."""
    out = []
    for row in rows:
        if row.get("private"):
            continue
        mid = str(row.get("id") or "")
        if not mid:
            continue
        out.append(
            {
                "id": mid,
                "content": str(row.get("content") or ""),
                "sender_type": str(row.get("sender_type") or ""),
                "created_at": str(row.get("created_at") or ""),
            }
        )
    return out


def transcript_from_l0(rows: list[dict]) -> str:
    return "\n".join(r.get("content") or "" for r in rows)


def quality_gate(l0: list[dict], *, min_chars: int = 8) -> bool:
    text = transcript_from_l0(l0).strip()
    return len(text) >= min_chars and len(l0) >= 1


def bootstrap_memory(ego: list[dict], *, conversation_id: str | None = None) -> dict:
    """L3 persona summary + at most one active L2 scenario (no L1/L0 dump)."""
    persona = {"summary": "", "preferences": [], "pain_points": []}
    scenarios = []
    for n in ego:
        et = n.get("entity_type")
        props = n.get("properties") or {}
        if et == "Customer" or (n.get("relation_type") is None and et is None):
            pass
        if et in ("Preference",) or n.get("relation_type") == "PREFERS":
            persona["preferences"].append({"id": n.get("id"), "name": n.get("name")})
        if et in ("PainPoint",) or n.get("relation_type") == "EXPERIENCED":
            persona["pain_points"].append({"id": n.get("id"), "name": n.get("name")})
        if et == "Scenario" or n.get("relation_type") == "HAS_SCENARIO":
            scenarios.append(
                {
                    "id": n.get("id"),
                    "name": n.get("name"),
                    "properties": props,
                    "relation_type": n.get("relation_type"),
                }
            )
        if isinstance(props, dict) and props.get("summary") and et == "Customer":
            persona["summary"] = str(props["summary"])
    # Customer summary may live on a center node not returned in hops; keep prefs/pains.
    active = None
    if scenarios:
        if conversation_id:
            for s in scenarios:
                props = s.get("properties") or {}
                if str(props.get("conversation_id") or "") == conversation_id:
                    active = s
                    break
        if active is None:
            active = scenarios[0]
    return {"layer": LAYER_L3, "persona": persona, "scenario": active}


def drill_down_graph(
    from_layer: str,
    ref_id: str,
    *,
    edges: list[dict],
    nodes: dict[str, dict],
    messages: dict[str, dict] | None = None,
) -> dict:
    """Pure link traverse: one hop only. Similarity is not used."""
    messages = messages or {}
    layer = (from_layer or "").upper()
    rid = str(ref_id or "")
    if not rid:
        return {"miss": True, "reason": "ref_id", "items": []}

    def valid(e: dict) -> bool:
        return not e.get("valid_until")

    if layer == LAYER_L3:
        items = []
        for e in edges:
            if not valid(e):
                continue
            if e.get("relation_type") == "HAS_SCENARIO" and str(e.get("source_node_id")) == rid:
                tid = str(e.get("target_node_id"))
                node = nodes.get(tid) or {"id": tid}
                items.append({**node, "layer": LAYER_L2, "edge": "HAS_SCENARIO"})
        return {"miss": not items, "items": items, "from_layer": layer, "ref_id": rid}

    if layer == LAYER_L2:
        items = []
        for e in edges:
            if not valid(e):
                continue
            if e.get("relation_type") == "CONTAINS_ATOM" and str(e.get("source_node_id")) == rid:
                tid = str(e.get("target_node_id"))
                node = nodes.get(tid) or {"id": tid}
                items.append({**node, "layer": LAYER_L1, "edge": "CONTAINS_ATOM"})
        return {"miss": not items, "items": items, "from_layer": layer, "ref_id": rid}

    if layer == LAYER_L1:
        node = nodes.get(rid) or {}
        props = node.get("properties") or {}
        ids = props.get("source_message_ids") or []
        items = []
        for mid in ids:
            mid = str(mid)
            msg = messages.get(mid) or {"id": mid}
            items.append({**msg, "layer": LAYER_L0})
        return {"miss": not items, "items": items, "from_layer": layer, "ref_id": rid}

    return {"miss": True, "reason": "layer", "items": []}


def drill_up_graph(
    from_layer: str,
    ref_id: str,
    *,
    edges: list[dict],
    nodes: dict[str, dict],
) -> dict:
    layer = (from_layer or "").upper()
    rid = str(ref_id or "")
    if not rid:
        return {"miss": True, "reason": "ref_id", "items": []}

    def valid(e: dict) -> bool:
        return not e.get("valid_until")

    if layer == LAYER_L0:
        items = []
        for nid, node in nodes.items():
            props = node.get("properties") or {}
            ids = [str(x) for x in (props.get("source_message_ids") or [])]
            if rid in ids:
                items.append({**node, "id": nid, "layer": LAYER_L1, "edge": "GROUNDED_IN"})
        return {"miss": not items, "items": items, "from_layer": layer, "ref_id": rid}

    if layer == LAYER_L1:
        items = []
        for e in edges:
            if not valid(e):
                continue
            if e.get("relation_type") == "CONTAINS_ATOM" and str(e.get("target_node_id")) == rid:
                sid = str(e.get("source_node_id"))
                node = nodes.get(sid) or {"id": sid}
                items.append({**node, "layer": LAYER_L2, "edge": "CONTAINS_ATOM"})
        return {"miss": not items, "items": items, "from_layer": layer, "ref_id": rid}

    if layer == LAYER_L2:
        items = []
        for e in edges:
            if not valid(e):
                continue
            if e.get("relation_type") == "HAS_SCENARIO" and str(e.get("target_node_id")) == rid:
                sid = str(e.get("source_node_id"))
                node = nodes.get(sid) or {"id": sid}
                items.append({**node, "layer": LAYER_L3, "edge": "HAS_SCENARIO"})
        return {"miss": not items, "items": items, "from_layer": layer, "ref_id": rid}

    return {"miss": True, "reason": "layer", "items": []}


def build_pyramid_payload(
    *,
    center_id: str,
    contact_id: str,
    conversation_id: str,
    l0: list[dict],
    extracted: dict[str, Any],
    new_id: Callable[[], str],
) -> dict[str, Any] | None:
    """Build ontology_extracted nodes/edges with mandatory pyramid links."""
    if not quality_gate(l0):
        return None
    msg_ids = [r["id"] for r in l0]
    nodes: list[dict] = [
        {
            "id": center_id,
            "entity_type": "Customer",
            "name": "Customer",
            "external_ref_id": contact_id,
            "properties": {},
        }
    ]
    edges: list[dict] = []
    atom_ids: list[str] = []
    names: list[str] = []
    for node, edge in zip(extracted.get("nodes") or [], extracted.get("edges") or []):
        nid = new_id()
        props = dict(node.get("properties") or {})
        src = props.get("source_message_ids") or msg_ids
        if not src:
            continue
        props["source_message_ids"] = [str(x) for x in src]
        et = node.get("entity_type") or "PainPoint"
        name = node.get("name") or et
        nodes.append(
            {
                "id": nid,
                "entity_type": et,
                "name": name,
                "external_ref_id": node.get("external_ref_id") or "",
                "properties": props,
            }
        )
        edges.append(
            {
                "id": new_id(),
                "source_node_id": center_id,
                "target_node_id": nid,
                "relation_type": edge.get("relation_type") or "EXPERIENCED",
                "weight": 1.0,
                "confidence": 0.8,
                "source_conversation_id": conversation_id,
            }
        )
        atom_ids.append(nid)
        names.append(name)
    if not atom_ids:
        # still allow persona-less skip
        return None
    scenario_id = new_id()
    scenario_name = " / ".join(names[:3]) or "상담"
    nodes.append(
        {
            "id": scenario_id,
            "entity_type": "Scenario",
            "name": scenario_name,
            "external_ref_id": "",
            "properties": {"conversation_id": conversation_id},
        }
    )
    for aid in atom_ids:
        edges.append(
            {
                "id": new_id(),
                "source_node_id": scenario_id,
                "target_node_id": aid,
                "relation_type": "CONTAINS_ATOM",
                "weight": 1.0,
                "confidence": 1.0,
                "source_conversation_id": conversation_id,
            }
        )
    edges.append(
        {
            "id": new_id(),
            "source_node_id": center_id,
            "target_node_id": scenario_id,
            "relation_type": "HAS_SCENARIO",
            "weight": 1.0,
            "confidence": 1.0,
            "source_conversation_id": conversation_id,
        }
    )
    summary = f"{scenario_name} 이력이 있는 고객"
    nodes[0]["properties"] = {"summary": summary}
    return {"nodes": nodes, "edges": edges}


MemoryReader = Callable[..., Awaitable[Any]]


def memory_tools(
    *,
    drill_down: Callable[[str, str], Awaitable[dict] | dict],
    drill_up: Callable[[str, str], Awaitable[dict] | dict],
    search: Callable[[str, str], Awaitable[dict] | dict],
):
    """LangChain @tool wrappers bound to account/conversation readers."""
    from langchain.tools import tool

    @tool
    async def memory_drill_down(from_layer: str, ref_id: str) -> str:
        """계층 한 칸 아래로: L3→L2→L1→L0. 링크만 따른다."""
        result = drill_down(from_layer, ref_id)
        if hasattr(result, "__await__"):
            result = await result  # type: ignore[misc]
        return json.dumps(result, ensure_ascii=False)

    @tool
    async def memory_drill_up(from_layer: str, ref_id: str) -> str:
        """계층 한 칸 위로: L0→L1→L2→L3. 링크만 따른다."""
        result = drill_up(from_layer, ref_id)
        if hasattr(result, "__await__"):
            result = await result  # type: ignore[misc]
        return json.dumps(result, ensure_ascii=False)

    @tool
    async def memory_search(layer: str, query: str) -> str:
        """L1 또는 L0에서 후보 ref_id를 찾는다. 계층 점프는 하지 않는다."""
        result = search(layer, query)
        if hasattr(result, "__await__"):
            result = await result  # type: ignore[misc]
        return json.dumps(result, ensure_ascii=False)

    return [memory_drill_down, memory_drill_up, memory_search]
