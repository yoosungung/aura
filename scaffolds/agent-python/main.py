"""Tenant agent bundle scaffold (python).

Same agent as agent-nodejs: tools = naver_search + weather (via mcp_invoke, not inlined).
Entrypoint: main:factory
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from lib.meta import TAG
from lib.tools import DEFAULT_SYSTEM_PROMPT, match_tool, resolve_tools


def factory(cfg, secrets_ref):
    c = cfg if isinstance(cfg, dict) else {}
    system = (
        str(c["system_prompt"])
        if c.get("system_prompt") is not None
        else str(c["systemPrompt"])
        if c.get("systemPrompt") is not None
        else DEFAULT_SYSTEM_PROMPT
    )
    tools = resolve_tools(c.get("tools"))
    local_mcp: Optional[Callable[..., Any]] = (
        c.get("_mcp_tool") if callable(c.get("_mcp_tool")) else None
    )

    async def runTurn(ctx=None):
        frame = ctx if isinstance(ctx, dict) else {}
        raw_input = frame.get("input") if isinstance(frame.get("input"), dict) else frame
        message = ""
        if isinstance(raw_input.get("text"), str):
            message = raw_input["text"]
        elif isinstance(raw_input.get("message"), str):
            message = raw_input["message"]

        mcp_tool = frame.get("mcpTool") if callable(frame.get("mcpTool")) else local_mcp

        tool_result = None
        tool_req = raw_input.get("tool")
        if tool_req is not None:
            spec = match_tool(tools, tool_req)
            if not spec:
                return {
                    "ok": False,
                    "error": "tool_not_allowed",
                    "tool": (tool_req.get("name") or tool_req.get("tool"))
                    if isinstance(tool_req, dict)
                    else None,
                    "tools": tools,
                }
            if not callable(mcp_tool):
                return {"ok": False, "error": "mcp_tool_required", "tools": tools}
            tool_result = await mcp_tool(
                {
                    "action": "call",
                    "server": tool_req.get("server") or spec["server"],
                    "version": tool_req.get("version") or spec["version"],
                    "tool": spec["name"],
                    "arguments": tool_req.get("arguments")
                    or tool_req.get("input")
                    or {},
                }
            )

        secrets = frame.get("secrets_ref")
        if secrets is None:
            secrets = secrets_ref
        return {
            "ok": True,
            "tag": TAG,
            "text": f"ack:{message}" if message else "ack",
            "system": system,
            "tools": tools,
            "toolResult": tool_result,
            "secrets_ref": secrets,
        }

    return {"runTurn": runTurn}
