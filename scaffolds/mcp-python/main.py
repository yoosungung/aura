"""Tenant MCP bundle scaffold (python) — Open-Meteo weather example. Entrypoint: main:factory"""

from __future__ import annotations

from lib.meta import TAG
from lib.weather import fetch_weather

TOOL = {
    "name": "weather",
    "description": (
        "Open-Meteo forecast (no API key). Requires latitude/longitude. "
        "Cluster egress must allow api.open-meteo.com."
    ),
    "inputSchema": {
        "type": "object",
        "required": ["latitude", "longitude"],
        "properties": {
            "latitude": {"type": "number", "description": "WGS84 latitude"},
            "longitude": {"type": "number", "description": "WGS84 longitude"},
            "forecast_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16,
                "description": "1–16 (default cfg or 1)",
            },
            "timezone": {"type": "string", "description": "IANA tz or auto (default)"},
        },
    },
}


def factory(cfg, secrets):
    """secrets unused (no key). Kept for factory(cfg, secrets) contract parity."""
    _ = secrets
    c = cfg if isinstance(cfg, dict) else {}
    default_days = c.get("forecast_days", 1)
    default_tz = c.get("timezone", "auto")
    fetch_impl = c.get("fetch_impl") or c.get("_fetch")

    async def listTools(_ctx=None):
        return {"ok": True, "tools": [TOOL]}

    async def runTool(ctx):
        ctx = ctx or {}
        tool = ctx.get("tool")
        if tool != "weather":
            return {"ok": False, "error": "unknown_tool", "tool": tool}
        inp = ctx.get("input") or {}
        out = await fetch_weather(
            latitude=inp.get("latitude"),
            longitude=inp.get("longitude"),
            forecast_days=inp.get("forecast_days", default_days),
            timezone=inp.get("timezone", default_tz),
            fetch_impl=fetch_impl,
        )
        if not out.get("ok"):
            return out
        return {"ok": True, "tag": TAG, "tool": "weather", **out}

    return {"listTools": listTools, "runTool": runTool}
