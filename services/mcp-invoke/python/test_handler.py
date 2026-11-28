"""pytest — mcp_invoke python parity (shared testdata)."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "object-store"))
from bundle_cache import BundleCache  # noqa: E402

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
    assert out["ok"] is False
    assert out["error"] == "mcp_backend_missing"


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
    assert body["ok"] is False
    assert body["error"] == "mcp_backend_missing"


@pytest.mark.asyncio
async def test_default_load_bundle_caches_bytes(fixtures):
    fx = json.loads((Path(__file__).resolve().parents[1] / "testdata" / "mcp_bundle.json").read_text())
    raw = fx["py"].encode("utf-8")
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    tenant = fixtures["valid_list"]["principal"]["tenant_id"]
    source = {
        "entrypoint": fx["entrypoint"],
        "sig_uri": fx["sig_uri"],
        "checksum": checksum,
        "bundle_uri": f"s3://aura-content/tenants/{tenant}/bundles/mcp/demo/1/mod.py",
    }
    calls = {"n": 0}

    async def fetch(_url, _headers):
        calls["n"] += 1
        return {"status": 200, "body": raw}

    cache = BundleCache()

    async def resolve(flag):
        async def _resolve(_req):
            return {
                "runtime": "python",
                "cfg": {"flag": flag},
                "secrets_ref": "secret://demo",
                "source": source,
            }

        return _resolve

    deps = {
        "object_fetch": fetch,
        "object_endpoint": "http://rustfs.aura.svc.cluster.local:9000",
        "object_region": "us-east-1",
        "object_access_key_id": "lab-access",
        "object_secret_access_key": "lab-secret-not-for-logs",
        "bundle_cache": cache,
    }
    req = dict(fixtures["valid_list"])
    first = await invoke_tool_once(req, {**deps, "resolve": await resolve(True)})
    call = dict(fixtures["valid_list"])
    call["action"] = "call"
    call["tool"] = "echo"
    second = await invoke_tool_once(call, {**deps, "resolve": await resolve(False)})
    assert first["ok"] is True
    assert second["ok"] is True
    assert second["result"]["cfg_flag"] is False
    assert calls["n"] == 1
