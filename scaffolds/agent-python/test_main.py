import asyncio

from lib.tools import DEFAULT_TOOLS
from main import factory


def test_agent_tools_and_mcp_dispatch():
    calls = []

    async def mcp_tool(req):
        calls.append(req)
        return {"ok": True, "echo": req}

    agent = factory({"system_prompt": "test-agent", "_mcp_tool": mcp_tool}, "vault:ref")
    plain = asyncio.run(agent["runTurn"]({"message": "hi"}))
    assert plain["ok"] is True
    assert plain["tag"] == "scaffold-agent"
    assert plain["text"] == "ack:hi"
    assert plain["system"] == "test-agent"
    assert plain["secrets_ref"] == "vault:ref"
    assert [t["name"] for t in plain["tools"]] == [t["name"] for t in DEFAULT_TOOLS]

    naver = asyncio.run(
        agent["runTurn"](
            {
                "input": {
                    "text": "search",
                    "tool": {"name": "naver_search", "arguments": {"query": "aura"}},
                },
                "mcpTool": mcp_tool,
                "secrets_ref": "vault:ref",
            }
        )
    )
    assert naver["ok"] is True
    assert naver["toolResult"]["ok"] is True
    assert calls[0]["server"] == "naver-search"
    assert calls[0]["tool"] == "naver_search"
    assert calls[0]["arguments"] == {"query": "aura"}

    wx = asyncio.run(
        agent["runTurn"](
            {
                "text": "forecast",
                "tool": {
                    "name": "weather",
                    "arguments": {"latitude": 37.57, "longitude": 126.98},
                },
            }
        )
    )
    assert wx["ok"] is True
    assert calls[1]["server"] == "weather"
    assert calls[1]["tool"] == "weather"

    denied = asyncio.run(
        agent["runTurn"]({"tool": {"name": "not_a_tool", "arguments": {}}})
    )
    assert denied["ok"] is False
    assert denied["error"] == "tool_not_allowed"

    no_mcp = asyncio.run(
        factory({"system_prompt": "x"}, None)["runTurn"](
            {"tool": {"name": "weather", "arguments": {}}}
        )
    )
    assert no_mcp["ok"] is False
    assert no_mcp["error"] == "mcp_tool_required"
