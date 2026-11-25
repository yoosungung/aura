import asyncio

from main import factory


def test_mcp_factory_list_and_run():
    mcp = factory({"flag": "lab"}, "vault:ref")
    listed = asyncio.run(mcp["listTools"]())
    assert listed["ok"] is True
    assert listed["tools"][0]["name"] == "echo"

    ran = asyncio.run(mcp["runTool"]({"tool": "echo", "input": {"x": 1}}))
    assert ran["ok"] is True
    assert ran["tool"] == "echo"
    assert ran["flag"] == "lab"
    assert ran["secrets_ref"] == "vault:ref"
