from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

from fastmcp import FastMCP

from aura_ai.tools import HIGH_RISK, run_low_risk

DEFAULT_HIGH_RISK = set(HIGH_RISK)


def stub_ops_server() -> FastMCP:
    mcp = FastMCP("ops")

    @mcp.tool
    def lookup_order(order_id: str) -> dict:
        """주문 상태를 조회한다."""
        return run_low_risk("lookup_order", {"order_id": order_id})

    @mcp.tool
    def lookup_shipping(order_id: str) -> dict:
        """배송 위치를 조회한다."""
        return run_low_risk("lookup_shipping", {"order_id": order_id})

    @mcp.tool
    def refund(amount: float, reason: str = "") -> dict:
        """환불. 고위험. 상담원 승인 필요."""
        return {"executed": True, "amount": amount, "reason": reason}

    @mcp.tool
    def cancel_subscription(reason: str = "") -> dict:
        """구독 해지. 고위험."""
        return {"executed": True, "reason": reason}

    @mcp.tool
    def change_plan(plan: str) -> dict:
        """요금제 변경. 고위험."""
        return {"executed": True, "plan": plan}

    return mcp


KNOWN_OPS = ("lookup_order", "lookup_shipping", "refund", "cancel_subscription", "change_plan", "send_status", "load_skill")


def canonical_tool_name(name: str) -> str:
    for ops in KNOWN_OPS:
        if name == ops or name.endswith("_" + ops):
            return ops
    return name


def is_ops_high_risk(name: str, extra: set[str] | None = None) -> bool:
    canon = canonical_tool_name(name)
    names = DEFAULT_HIGH_RISK | set(extra or ())
    return canon in names


def run_sync(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}

    def worker() -> None:
        result["value"] = asyncio.run(coro)

    import threading

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    if "value" not in result:
        raise RuntimeError("async tool failed")
    return result["value"]


async def list_mcp_tools(server: Any = None, config: dict | None = None) -> list:
    from langchain.mcp import MCPAdapter

    target = config if config is not None else (server or stub_ops_server())
    async with MCPAdapter(target) as adapter:
        return await adapter.list_tools()


def load_ops_tools(server: Any = None, config: dict | None = None) -> list:
    return run_sync(list_mcp_tools(server, config))


def _parse_tool_out(out: Any) -> dict:
    if isinstance(out, dict):
        if "executed" in out or "status" in out or "result" not in out:
            return out
        inner = out.get("result")
        parsed = _parse_tool_out(inner) if inner is not None and inner is not out else out
        return parsed
    if isinstance(out, list):
        text = "".join(
            item if isinstance(item, str) else str(item.get("text") or "") if isinstance(item, dict) else str(item)
            for item in out
        )
        return _parse_tool_out(text)
    if isinstance(out, str):
        try:
            parsed = json.loads(out)
        except json.JSONDecodeError:
            return {"result": out}
        if isinstance(parsed, dict):
            return parsed
        return {"result": parsed}
    return {"result": out}


def invoke_tool(tools: list, name: str, args: dict) -> dict:
    canon = canonical_tool_name(name)
    for tool in tools:
        if tool.name == name or canonical_tool_name(tool.name) == canon:
            invoke = getattr(tool, "ainvoke", None)
            if invoke is not None:
                out = run_sync(invoke(args))
            else:
                out = tool.invoke(args)
            return _parse_tool_out(out)
    return run_low_risk(canon, args)


def config_from_rows(rows: list[dict]) -> dict | None:
    servers: dict[str, dict] = {}
    for row in rows:
        if not row.get("enabled", True):
            continue
        url = (row.get("url") or "").strip()
        if not url:
            continue
        entry: dict[str, Any] = {"url": url}
        auth = (row.get("auth_header") or "").strip()
        if auth:
            entry["headers"] = {"Authorization": auth}
        servers[row.get("name") or f"ops{len(servers)}"] = entry
    if not servers:
        return None
    return {"mcpServers": servers}


ReadMcp = Callable[[str], list[dict]]
