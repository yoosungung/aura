"""pytest — mcp_invoke python parity (shared testdata)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from starlette.requests import Request

from handler import invoke_tool_once, main, validate_mcp_request

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


async def _json_request(payload: dict) -> Request:
    body = json.dumps(payload).encode("utf-8")

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
            "client": ("127.0.0.1", 123),
            "server": ("test", 80),
        },
        receive,
    )


@pytest.mark.asyncio
async def test_main_request_json_roundtrip(fixtures):
    req = await _json_request(dict(fixtures["valid_list"]))
    resp = await main(req)
    assert resp.media_type == "application/json"
    body = json.loads(resp.body.decode("utf-8"))
    assert body["type"] == "mcp.invoke.done"
    assert body["action"] == "list"
    assert body["runtime"] == "python"
