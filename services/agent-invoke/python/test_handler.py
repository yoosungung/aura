"""pytest — agent_invoke python parity (shared testdata)."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "object-store"))
from bundle_cache import BundleCache  # noqa: E402

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
    spec = validate_invoke_task(fixtures["invalid_spec"])
    assert spec["ok"] is False
    assert spec["error"] == "identifiers_only"


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


@pytest.mark.asyncio
async def test_invoke_once_applies_cfg(fixtures):
    seen = []

    def create_agent(args):
        seen.append(args)

        class Agent:
            async def invoke(self, _payload):
                return {"content": args["system_prompt"]}

        return Agent()

    async def resolve(_req):
        return {
            "runtime": "python",
            "cfg": {"system_prompt": "You are support.", "tools": []},
        }

    out = await invoke_once(
        fixtures["valid"],
        {"resolve": resolve, "create_agent": create_agent},
    )
    assert out["ok"] is True
    assert out["output"]["text"].startswith("You are support.")
    assert seen[0]["system_prompt"].startswith("You are support.")


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


@pytest.mark.asyncio
async def test_signed_bundle_run_turn_uses_cache(fixtures):
    src = (
        "def factory(cfg, secrets_ref):\n"
        "    async def runTurn(_ctx):\n"
        "        return {'text': 'bundle:' + str(cfg.get('flag'))}\n"
        "    return {'runTurn': runTurn}\n"
    )
    raw = src.encode("utf-8")
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    tenant = fixtures["valid"]["principal"]["tenant_id"]
    source = {
        "entrypoint": "main:factory",
        "sig_uri": f"s3://aura-content/tenants/{tenant}/bundles/agent/demo/1/sig",
        "checksum": checksum,
        "bundle_uri": f"s3://aura-content/tenants/{tenant}/bundles/agent/demo/1/mod.py",
    }
    calls = {"n": 0}

    async def fetch(_url, _headers):
        calls["n"] += 1
        return {"status": 200, "body": raw}

    cache = BundleCache()

    async def run(flag):
        async def resolve(_req):
            return {
                "runtime": "python",
                "cfg": {"flag": flag},
                "secrets_ref": "secret://demo",
                "source": source,
            }

        task = dict(fixtures["valid"])
        return await invoke_once(
            task,
            {
                "resolve": resolve,
                "object_fetch": fetch,
                "object_endpoint": "http://garage.aura.svc.cluster.local:3900",
                "object_region": "garage",
                "object_access_key_id": "lab-access",
                "object_secret_access_key": "lab-secret-not-for-logs",
                "bundle_cache": cache,
            },
        )

    first = await run("one")
    second = await run("two")
    assert first["output"]["text"] == "bundle:one"
    assert second["output"]["text"] == "bundle:two"
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_platform_marker_skips_get_object(fixtures):
    calls = {"n": 0}

    async def fetch(_url, _headers):
        calls["n"] += 1
        return {"status": 200, "body": b""}

    async def resolve(_req):
        return {"runtime": "python", "cfg": {}, "source": {"entrypoint": "aura:createAgent"}}

    out = await invoke_once(
        fixtures["valid"],
        {"resolve": resolve, "object_fetch": fetch},
    )
    assert out["ok"] is True
    assert calls["n"] == 0
