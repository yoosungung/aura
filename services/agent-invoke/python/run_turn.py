"""create_agent turn parity with nodejs/run-turn-create-agent.js.

cfg.system_prompt / tools allowlist / sub_agents. Injectable create_agent.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

MAX_AGENT_DEPTH = 2


def agent_key(name: str, version: str) -> str:
    return f"{name}@{version}"


def with_agent(frame: dict[str, Any], agent_name: str | None) -> dict[str, Any]:
    if not agent_name:
        return frame
    if frame.get("type") in ("token", "tool.started", "tool.finished"):
        return {**frame, "agent": agent_name}
    return frame


def _allowlisted(spec: Any) -> bool:
    return (
        isinstance(spec, dict)
        and isinstance(spec.get("server"), str)
        and spec["server"]
        and isinstance(spec.get("name"), str)
        and spec["name"]
        and isinstance(spec.get("version"), str)
        and spec["version"]
    )


def _bind_mcp(mcp_tool, principal, publish, run_id, stream, spec) -> dict[str, Any]:
    tool = spec["name"]
    server = spec["server"]
    version = spec["version"]

    async def invoke(inp: Any = None) -> Any:
        src = inp if isinstance(inp, dict) else {}
        call_tool = src.get("tool") or src.get("name") or tool
        call_server = src.get("server") or server
        call_version = src.get("version") or version
        args = src.get("arguments") if isinstance(src.get("arguments"), dict) else src
        if stream and publish:
            await publish(run_id, {"type": "tool.started", "tool": call_tool, "server": call_server})
        if callable(mcp_tool):
            out = await mcp_tool(
                {
                    "action": "call",
                    "server": call_server,
                    "version": call_version,
                    "tool": call_tool,
                    "arguments": args,
                    "principal": principal,
                }
            )
        else:
            out = {"ok": False, "error": "mcp_tool_required"}
        if stream and publish:
            await publish(
                run_id,
                {
                    "type": "tool.finished",
                    "tool": call_tool,
                    "server": call_server,
                    "summary": "error" if isinstance(out, dict) and out.get("ok") is False else "ok",
                },
            )
        return out

    return {
        "name": tool,
        "description": spec.get("description") or f"MCP {server}@{version} {tool}",
        "invoke": invoke,
    }


def wrap_mcp_tools(mcp_tool, principal, publish, run_id, stream, allowlist) -> list[dict[str, Any]]:
    if isinstance(allowlist, list):
        return [
            _bind_mcp(mcp_tool, principal, publish, run_id, stream, spec)
            for spec in allowlist
            if _allowlisted(spec)
        ]
    if not callable(mcp_tool):
        return []
    return [
        _bind_mcp(
            mcp_tool,
            principal,
            publish,
            run_id,
            stream,
            {
                "name": "mcp_tool",
                "server": "default",
                "version": "1.0.0",
                "description": "Call an MCP tool via aura.rpc.mcp.tool",
            },
        )
    ]


def match_input_tool(tools: list[dict[str, Any]], tool_req: Any) -> dict[str, Any] | None:
    if not isinstance(tool_req, dict) or not tools:
        return None
    if len(tools) == 1 and tools[0].get("name") == "mcp_tool":
        return tools[0]
    name = tool_req.get("name") or tool_req.get("tool")
    for tool in tools:
        if tool.get("name") == name:
            return tool
    return None


def _fail(message: str, status: int) -> Exception:
    err = RuntimeError(message)
    setattr(err, "status", status)
    return err


def sub_agent_tools(ctx: dict[str, Any], stack: list[str], depth: int, opts: dict[str, Any]) -> list[dict[str, Any]]:
    cfg = ctx.get("cfg") if isinstance(ctx.get("cfg"), dict) else {}
    specs = cfg.get("sub_agents") if isinstance(cfg.get("sub_agents"), list) else []
    if depth >= MAX_AGENT_DEPTH:
        return []
    out = []
    for spec in specs:
        if not (
            isinstance(spec, dict)
            and isinstance(spec.get("name"), str)
            and spec["name"]
            and isinstance(spec.get("version"), str)
            and spec["version"]
        ):
            continue
        name = spec["name"]
        version = spec["version"]

        async def invoke(inp: Any = None, spec_name=name, spec_version=version) -> Any:
            child_key = agent_key(spec_name, spec_version)
            if child_key in stack:
                raise _fail("agent_cycle", 400)
            if depth + 1 > MAX_AGENT_DEPTH:
                raise _fail("agent_depth_exceeded", 400)
            resolve = ctx.get("resolve")
            if not callable(resolve):
                raise _fail("resolve_rpc_required", 500)
            principal = ctx.get("principal")
            resolved = await resolve(
                {
                    "tenant_id": principal.get("tenant_id") if isinstance(principal, dict) else None,
                    "kind": "agent",
                    "name": spec_name,
                    "version": spec_version,
                    "principal": principal,
                }
            )
            if not isinstance(resolved, dict) or resolved.get("type") == "control.resolve.error":
                raise _fail("sub_agent_not_active", 404)
            text = ""
            if isinstance(inp, str):
                text = inp
            elif isinstance(inp, dict):
                text = str(inp.get("text") or inp.get("task") or inp.get("query") or "")
            child = {
                "run_id": ctx.get("run_id"),
                "agent": spec_name,
                "version": spec_version,
                "session_id": ctx.get("session_id"),
                "input": {"text": text},
                "principal": principal,
                "cfg": resolved.get("cfg") or {},
                "secrets_ref": resolved.get("secrets_ref"),
                "memory_text": ctx.get("memory_text") or "",
                "stream": ctx.get("stream"),
                "publish_stream": ctx.get("publish_stream"),
                "mcp_tool": ctx.get("mcp_tool"),
                "resolve": resolve,
                "depth": depth + 1,
                "agent_stack": list(stack),
            }
            return await run_agent_turn(child, opts)

        out.append(
            {
                "name": f"subagent_{name}",
                "description": spec.get("description") or name,
                "invoke": invoke,
            }
        )
    return out


async def run_agent_turn(ctx: dict[str, Any], opts: dict[str, Any] | None = None) -> dict[str, Any]:
    o = opts or {}
    depth = int(ctx.get("depth") or 1)
    if depth > MAX_AGENT_DEPTH:
        raise _fail("agent_depth_exceeded", 400)
    stack = list(ctx.get("agent_stack") or [])
    agent = ctx.get("agent")
    version = ctx.get("version")
    if agent and version and agent_key(str(agent), str(version)) in stack:
        raise _fail("agent_cycle", 400)
    if agent and version:
        stack.append(agent_key(str(agent), str(version)))

    stream = ctx.get("stream") is not False
    raw_publish = ctx.get("publish_stream")
    agent_name = agent if isinstance(agent, str) else None

    async def publish(run_id, frame):
        if not callable(raw_publish):
            return None
        return await raw_publish(run_id, with_agent(frame, agent_name))

    cfg = ctx.get("cfg") if isinstance(ctx.get("cfg"), dict) else {}
    allowlist = cfg.get("tools") if isinstance(cfg.get("tools"), list) else None
    tools = wrap_mcp_tools(
        ctx.get("mcp_tool"),
        ctx.get("principal"),
        publish,
        ctx.get("run_id"),
        stream,
        allowlist,
    ) + sub_agent_tools(ctx, stack, depth, o)

    create_agent = o.get("create_agent", ctx.get("create_agent"))
    if create_agent is None:
        create_agent = _try_load_create_agent()
    system_prompt = cfg.get("system_prompt") or "You are an Aura agent."
    memory = ctx.get("memory_text") or ""
    if memory:
        system_prompt = f"{system_prompt}\n\nMemory context:\n{memory}"

    chat_model = o.get("chat_model", ctx.get("chat_model"))
    gateway_url = ctx.get("llm_gateway_base_url")
    if chat_model is None and isinstance(gateway_url, str) and gateway_url:
        from llm_gateway_model import assert_function_llm_egress, create_gateway_chat_model

        assert_function_llm_egress(gateway_url)
        principal = ctx.get("principal") if isinstance(ctx.get("principal"), dict) else {}
        chat_model = create_gateway_chat_model(
            base_url=gateway_url,
            tenant_id=str(principal.get("tenant_id") or ""),
            model=cfg.get("model") or "aura-default",
            transport=ctx.get("llm_transport"),
            route_pin=ctx.get("route_pin") or cfg.get("route_pin"),
        )

    if not callable(create_agent):
        return await _stub(ctx, tools, publish, system_prompt)

    agent_obj = create_agent(
        {
            "model": chat_model if chat_model is not None else (cfg.get("model") or "aura-default"),
            "tools": tools,
            "system_prompt": system_prompt,
            "name": agent,
        }
    )
    user_text = ""
    inp = ctx.get("input")
    if isinstance(inp, dict) and isinstance(inp.get("text"), str):
        user_text = inp["text"]
    out = await _call_agent(agent_obj, user_text)
    text = ""
    if isinstance(out, dict):
        text = str(out.get("content") or out.get("text") or "")
    elif isinstance(out, str):
        text = out
    if stream and text:
        await publish(ctx.get("run_id"), {"type": "token", "text": text})
    tool_req = inp.get("tool") if isinstance(inp, dict) else None
    matched = match_input_tool(tools, tool_req)
    tool_result = None
    if matched:
        tool_result = await matched["invoke"](
            {
                "tool": tool_req.get("name") or tool_req.get("tool"),
                "server": tool_req.get("server") or "default",
                "version": tool_req.get("version") or "1.0.0",
                "arguments": tool_req.get("arguments") or {},
            }
        )
    return {"text": text, "toolResult": tool_result, "mode": "create_agent_invoke"}


async def _call_agent(agent_obj: Any, user_text: str) -> Any:
    invoke = getattr(agent_obj, "invoke", None)
    if callable(invoke):
        result = invoke({"messages": [{"role": "user", "content": user_text}]})
        if isinstance(result, Awaitable):
            return await result
        return result
    if callable(agent_obj):
        result = agent_obj({"messages": [{"role": "user", "content": user_text}]})
        if isinstance(result, Awaitable):
            return await result
        return result
    return {"content": ""}


async def _stub(ctx, tools, publish, system_prompt: str) -> dict[str, Any]:
    inp = ctx.get("input") if isinstance(ctx.get("input"), dict) else {}
    input_text = inp.get("text") if isinstance(inp.get("text"), str) else ""
    memory = ctx.get("memory_text") or ""
    if memory:
        reply = f"ack:{input_text or 'ok'}|mem:{str(memory)[:64]}"
    else:
        reply = f"ack:{input_text or 'ok'}"
    if ctx.get("stream") is not False and callable(ctx.get("publish_stream")):
        await publish(ctx.get("run_id"), {"type": "token", "text": reply[:24]})
        if len(reply) > 24:
            await publish(ctx.get("run_id"), {"type": "token", "text": reply[24:]})
    matched = match_input_tool(tools, inp.get("tool"))
    tool_result = None
    if matched:
        tool_req = inp["tool"]
        tool_result = await matched["invoke"](
            {
                "tool": tool_req.get("name") or tool_req.get("tool"),
                "server": tool_req.get("server") or "default",
                "version": tool_req.get("version") or "1.0.0",
                "arguments": tool_req.get("arguments") or {},
            }
        )
    return {
        "text": reply,
        "toolResult": tool_result,
        "mode": "stub_agent_loop",
        "system_prompt": system_prompt,
    }


def _try_load_create_agent() -> Callable | None:
    try:
        from langchain.agents import create_agent  # type: ignore
    except Exception:
        return None
    return create_agent
