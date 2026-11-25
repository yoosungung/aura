import asyncio

from main import factory


def test_agent_factory_run_turn():
    agent = factory({"systemPrompt": "test"}, "vault:ref")
    out = asyncio.run(agent["runTurn"]({"message": "hi"}))
    assert out["ok"] is True
    assert out["echo"] == "hi"
    assert out["system"] == "test"
    assert out["secrets_ref"] == "vault:ref"
