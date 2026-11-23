"""pytest — create_agent cfg parity (shared testdata/agent_specs.json)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from run_turn import run_agent_turn

FIX = Path(__file__).resolve().parents[1] / "testdata" / "agent_specs.json"


def _specs():
    return json.loads(FIX.read_text())


def _ctx(**extra):
    base = {
        "run_id": "run-spec",
        "stream": False,
        "input": {"text": "ping"},
        "principal": {"id": "u", "tenant_id": "t"},
        "memory_text": "",
    }
    base.update(extra)
    return base


@pytest.mark.asyncio
async def test_two_cfgs_prompt_and_tools():
    specs = _specs()
    seen = []

    def create_agent(args):
        seen.append(args)

        class Agent:
            async def invoke(self, _payload):
                return {"content": args["system_prompt"]}

        return Agent()

    support = await run_agent_turn(
        _ctx(cfg=specs["support"], agent="support"),
        {"create_agent": create_agent},
    )
    research = await run_agent_turn(
        _ctx(cfg=specs["researcher"], agent="researcher"),
        {"create_agent": create_agent},
    )
    assert support["text"].startswith("You are support.")
    assert research["text"].startswith("You are research.")
    assert [t["name"] for t in seen[0]["tools"]] == ["search", "subagent_researcher"]
    assert [t["name"] for t in seen[1]["tools"]] == ["fetch", "subagent_support"]


@pytest.mark.asyncio
async def test_allowlist_blocks_unknown_tool():
    specs = _specs()
    calls = []

    async def mcp_tool(req):
        calls.append(req)
        return {"ok": True}

    def create_agent(_args):
        class Agent:
            async def invoke(self, _payload):
                return {"content": "ok"}

        return Agent()

    await run_agent_turn(
        _ctx(
            cfg=specs["support"],
            agent="support",
            mcp_tool=mcp_tool,
            input={"text": "x", "tool": {"name": "fetch", "server": "web", "version": "1.0.0"}},
        ),
        {"create_agent": create_agent},
    )
    assert calls == []
    await run_agent_turn(
        _ctx(
            cfg=specs["support"],
            agent="support",
            mcp_tool=mcp_tool,
            input={"text": "x", "tool": {"name": "search", "server": "docs", "version": "1.0.0"}},
        ),
        {"create_agent": create_agent},
    )
    assert calls[0]["tool"] == "search"
    assert calls[0]["server"] == "docs"


@pytest.mark.asyncio
async def test_sub_agent_reenter_and_depth_cap():
    specs = _specs()
    nested = []
    resolves = []

    def create_agent(args):
        nested.append(args)

        class Agent:
            async def invoke(self, _payload):
                if len(nested) == 1:
                    sub = next(t for t in args["tools"] if t["name"] == "subagent_researcher")
                    return await sub["invoke"]({"text": "look up"})
                return {"content": "child-out"}

        return Agent()

    frames = []

    async def publish(_run_id, frame):
        frames.append(frame)

    async def resolve(req):
        resolves.append(req)
        return {"type": "control.resolve.done", "cfg": specs["researcher"]}

    out = await run_agent_turn(
        _ctx(
            cfg=specs["support"],
            agent="support",
            version="1.0.0",
            stream=True,
            publish_stream=publish,
            resolve=resolve,
        ),
        {"create_agent": create_agent},
    )
    assert out["text"] == "child-out"
    assert resolves[0]["name"] == "researcher"
    assert resolves[0]["version"] == "1.0.0"
    assert nested[1]["system_prompt"].startswith("You are research.")
    assert [t["name"] for t in nested[1]["tools"]] == ["fetch"]
    assert any(f.get("type") == "token" and f.get("agent") == "researcher" for f in frames)


@pytest.mark.asyncio
async def test_depth_and_cycle_rejected():
    with pytest.raises(RuntimeError, match="agent_depth_exceeded"):
        await run_agent_turn(
            _ctx(depth=3, agent="leaf", version="1.0.0", cfg={"tools": []}),
            {"create_agent": lambda args: args},
        )
    with pytest.raises(RuntimeError, match="agent_cycle"):
        await run_agent_turn(
            _ctx(
                agent="support",
                version="1.0.0",
                agent_stack=["support@1.0.0"],
                cfg={
                    "system_prompt": "loop",
                    "tools": [],
                    "sub_agents": [{"name": "support", "version": "1.0.0", "description": "self"}],
                },
            ),
            {"create_agent": lambda args: args},
        )
