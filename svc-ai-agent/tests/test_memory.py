from aura_ai.memory import (
    bootstrap_memory,
    build_pyramid_payload,
    drill_down_graph,
    drill_up_graph,
    public_l0,
    quality_gate,
)


def test_public_l0_excludes_private():
    rows = [
        {"id": "m1", "content": "hi", "private": False},
        {"id": "m2", "content": "note", "private": True},
    ]
    assert [r["id"] for r in public_l0(rows)] == ["m1"]


def test_quality_gate():
    assert quality_gate([{"id": "m1", "content": "결제 오류로 문의합니다"}])
    assert not quality_gate([{"id": "m1", "content": "ok"}])


def test_drill_down_follows_links_only():
    nodes = {
        "s1": {"id": "s1", "entity_type": "Scenario", "name": "결제"},
        "a1": {
            "id": "a1",
            "entity_type": "PainPoint",
            "name": "오류",
            "properties": {"source_message_ids": ["msg1"]},
        },
    }
    edges = [
        {"source_node_id": "c1", "target_node_id": "s1", "relation_type": "HAS_SCENARIO"},
        {"source_node_id": "s1", "target_node_id": "a1", "relation_type": "CONTAINS_ATOM"},
    ]
    messages = {"msg1": {"id": "msg1", "content": "결제 실패"}}
    l2 = drill_down_graph("L3", "c1", edges=edges, nodes=nodes)
    assert not l2["miss"]
    assert l2["items"][0]["id"] == "s1"
    l1 = drill_down_graph("L2", "s1", edges=edges, nodes=nodes)
    assert l1["items"][0]["id"] == "a1"
    l0 = drill_down_graph("L1", "a1", edges=edges, nodes=nodes, messages=messages)
    assert l0["items"][0]["id"] == "msg1"
    # no similarity fallback: unknown ref misses
    assert drill_down_graph("L3", "missing", edges=edges, nodes=nodes)["miss"]


def test_drill_up_reverse_links():
    nodes = {
        "a1": {
            "id": "a1",
            "entity_type": "PainPoint",
            "properties": {"source_message_ids": ["msg1"]},
        },
        "s1": {"id": "s1", "entity_type": "Scenario"},
        "c1": {"id": "c1", "entity_type": "Customer"},
    }
    edges = [
        {"source_node_id": "s1", "target_node_id": "a1", "relation_type": "CONTAINS_ATOM"},
        {"source_node_id": "c1", "target_node_id": "s1", "relation_type": "HAS_SCENARIO"},
    ]
    assert drill_up_graph("L0", "msg1", edges=edges, nodes=nodes)["items"][0]["id"] == "a1"
    assert drill_up_graph("L1", "a1", edges=edges, nodes=nodes)["items"][0]["id"] == "s1"
    assert drill_up_graph("L2", "s1", edges=edges, nodes=nodes)["items"][0]["id"] == "c1"


def test_build_pyramid_payload_requires_links():
    l0 = [{"id": "m1", "content": "결제 오류로 환불 요청합니다"}]
    extracted = {
        "nodes": [{"entity_type": "PainPoint", "name": "결제 오류", "properties": {"source_message_ids": ["m1"]}}],
        "edges": [{"relation_type": "EXPERIENCED"}],
    }
    ids = iter(["a1", "e_domain", "s1", "e_contains", "e_has"])
    payload = build_pyramid_payload(
        center_id="c1",
        contact_id="contact",
        conversation_id="conv",
        l0=l0,
        extracted=extracted,
        new_id=lambda: next(ids),
    )
    assert payload is not None
    assert any(n["entity_type"] == "Scenario" for n in payload["nodes"])
    rels = {e["relation_type"] for e in payload["edges"]}
    assert "CONTAINS_ATOM" in rels and "HAS_SCENARIO" in rels
    atom = next(n for n in payload["nodes"] if n["entity_type"] == "PainPoint")
    assert atom["properties"]["source_message_ids"] == ["m1"]


def test_bootstrap_is_l3_l2_only():
    ego = [
        {"id": "p1", "entity_type": "Preference", "name": "카카오", "relation_type": "PREFERS"},
        {"id": "s1", "entity_type": "Scenario", "name": "결제", "relation_type": "HAS_SCENARIO", "properties": {}},
        {"id": "a1", "entity_type": "PainPoint", "name": "오류", "relation_type": "EXPERIENCED"},
    ]
    boot = bootstrap_memory(ego)
    assert boot["scenario"]["id"] == "s1"
    assert "preferences" in boot["persona"]
