"""pytest — MCP branch parity against testdata/mcp_bundle.json."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from handler import invoke_tool_once

FIX = Path(__file__).resolve().parents[1] / "testdata" / "mcp_bundle.json"
PRINCIPAL = {"id": "u1", "tenant_id": "11111111-1111-1111-1111-111111111111"}


def _fx():
    return json.loads(FIX.read_text())


def _checksum(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.mark.asyncio
async def test_http_fetch_called():
    calls = []

    async def fetch(url, init):
        calls.append((url, init))
        body = json.loads(init["body"])
        assert body["method"] == "tools/call"
        return {
            "headers": {"content-type": "application/json"},
            "text": json.dumps(
                {"jsonrpc": "2.0", "id": body["id"], "result": {"content": []}}
            ),
        }

    async def resolve(_req):
        return {
            "runtime": "python",
            "cfg": {
                "transport": "streamable_http",
                "mcp_endpoint": "https://mcp.test/v1",
                "mcp_session_id": "sid-1",
            },
        }

    out = await invoke_tool_once(
        {
            "server": "demo",
            "version": "1.0.0",
            "action": "call",
            "tool": "echo",
            "arguments": {"x": 1},
            "runtime": "python",
            "principal": PRINCIPAL,
        },
        {"resolve": resolve, "fetch": fetch},
    )
    assert out["ok"] is True
    assert calls[0][0] == "https://mcp.test/v1"
    assert calls[0][1]["headers"]["Mcp-Session-Id"] == "sid-1"
    assert out["result"]["mode"] == "streamable_http"


@pytest.mark.asyncio
async def test_signed_bundle_and_rejections():
    fx = _fx()
    digest = _checksum(fx["py"])
    source = {
        "entrypoint": fx["entrypoint"],
        "sig_uri": fx["sig_uri"],
        "checksum": digest,
    }

    async def resolve(_req):
        return {
            "runtime": "python",
            "cfg": {"flag": True},
            "secrets_ref": "secret://demo",
            "source": source,
        }

    async def load_bundle(_source):
        return fx["py"].encode("utf-8")

    listed = await invoke_tool_once(
        {
            "server": "demo",
            "version": "1.0.0",
            "action": "list",
            "runtime": "python",
            "principal": PRINCIPAL,
        },
        {"resolve": resolve, "load_bundle": load_bundle},
    )
    assert listed["tools"][0]["name"] == "bundled"

    called = await invoke_tool_once(
        {
            "server": "demo",
            "version": "1.0.0",
            "action": "call",
            "tool": "echo",
            "runtime": "python",
            "principal": PRINCIPAL,
        },
        {"resolve": resolve, "load_bundle": load_bundle},
    )
    assert called["result"]["bundled"] is True
    assert called["result"]["tool"] == "echo"
    assert called["result"]["secrets_ref"] == "secret://demo"
    assert called["result"]["cfg_flag"] is True

    async def bad_sum(_req):
        return {
            "runtime": "python",
            "cfg": {},
            "source": {**source, "checksum": "sha256:00"},
        }

    mismatch = await invoke_tool_once(
        {
            "server": "demo",
            "version": "1.0.0",
            "action": "list",
            "runtime": "python",
            "principal": PRINCIPAL,
        },
        {"resolve": bad_sum, "load_bundle": load_bundle},
    )
    assert mismatch["error"] == "bundle_checksum_mismatch"

    async def no_sig(_req):
        return {
            "runtime": "python",
            "cfg": {},
            "source": {"entrypoint": fx["entrypoint"], "checksum": digest},
        }

    untrusted = await invoke_tool_once(
        {
            "server": "demo",
            "version": "1.0.0",
            "action": "list",
            "runtime": "python",
            "principal": PRINCIPAL,
        },
        {"resolve": no_sig, "load_bundle": load_bundle},
    )
    assert untrusted["error"] == "bundle_untrusted"
