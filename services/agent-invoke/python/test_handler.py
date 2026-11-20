"""pytest — agent_invoke python parity (shared testdata)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from handler import assert_runtime_stamp, invoke_once, validate_invoke_task

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
