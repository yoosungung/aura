"""pytest — agent_invoke python parity (shared testdata)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from starlette.requests import Request

from handler import assert_runtime_stamp, invoke_once, main, validate_invoke_task

FIX = Path(__file__).resolve().parents[1] / "testdata" / "invoke_identifiers_only.json"


@pytest.fixture
def fixtures():
    return json.loads(FIX.read_text())


def test_identifiers_only_reject(fixtures):
    v = validate_invoke_task(fixtures["invalid"])
    assert v["ok"] is False
    assert v["error"] == "identifiers_only"


def test_valid_task(fixtures):
    v = validate_invoke_task(fixtures["valid"])
    assert v["ok"] is True


def test_runtime_mismatch():
    r = assert_runtime_stamp({"runtime": "nodejs"}, "python")
    assert r["ok"] is False
    assert r["error"] == "runtime_mismatch"


@pytest.mark.asyncio
async def test_invoke_once_python(fixtures):
    async def resolve(_req):
        return {"runtime": "python", "cfg": {}}

    out = await invoke_once(fixtures["valid"], {"resolve": resolve})
    assert out["type"] == "agent.invoke.done"
    assert out["ok"] is True
    assert out["runtime"] == "python"


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
    req = await _json_request(fixtures["valid"])
    resp = await main(req)
    assert resp.media_type == "application/json"
    body = json.loads(resp.body.decode("utf-8"))
    assert body["type"] == "agent.invoke.done"
    assert body["ok"] is True
    assert body["runtime"] == "python"
