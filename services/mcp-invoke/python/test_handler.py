"""pytest — mcp_invoke python parity (shared testdata)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from handler import invoke_tool_once, validate_mcp_request

FIX = Path(__file__).resolve().parents[1] / "testdata" / "mcp_identifiers_only.json"


@pytest.fixture
def fixtures():
    return json.loads(FIX.read_text())


def test_identifiers_only_reject(fixtures):
    v = validate_mcp_request(fixtures["invalid"])
    assert v["ok"] is False
    assert v["error"] == "identifiers_only"


def test_valid_list(fixtures):
    v = validate_mcp_request(dict(fixtures["valid_list"]))
    assert v["ok"] is True


@pytest.mark.asyncio
async def test_list_tools(fixtures):
    async def resolve(_req):
        return {"runtime": "python", "cfg": {}}

    out = await invoke_tool_once(dict(fixtures["valid_list"]), {"resolve": resolve})
    assert out["type"] == "mcp.invoke.done"
    assert out["action"] == "list"
    assert out["runtime"] == "python"
    assert isinstance(out["tools"], list)
