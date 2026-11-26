"""Default cfg.tools — same contract as agent-nodejs. MCP code is NOT in this zip."""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

DEFAULT_TOOLS: list[dict[str, str]] = [
    {
        "server": "naver-search",
        "version": "1",
        "name": "naver_search",
        "description": "Naver Search MCP (secrets_ref / Client Id·Secret)",
    },
    {
        "server": "weather",
        "version": "1",
        "name": "weather",
        "description": "Open-Meteo weather MCP (no API key)",
    },
]

DEFAULT_SYSTEM_PROMPT = (
    "You are a scaffold research agent. Use naver_search for Korean web/news search "
    "and weather for Open-Meteo forecasts. Do not invent tool results."
)


def resolve_tools(cfg_tools: Any) -> list[dict[str, str]]:
    if not isinstance(cfg_tools, list):
        return [dict(t) for t in DEFAULT_TOOLS]
    out: list[dict[str, str]] = []
    for t in cfg_tools:
        if not isinstance(t, Mapping):
            continue
        server = t.get("server")
        name = t.get("name")
        version = t.get("version")
        if not (isinstance(server, str) and server and isinstance(name, str) and name):
            continue
        if not (isinstance(version, str) and version):
            continue
        row = {"server": server, "version": version, "name": name}
        if t.get("description") is not None:
            row["description"] = str(t.get("description"))
        out.append(row)
    return out


def match_tool(
    allowlist: Sequence[Mapping[str, Any]], tool_req: Any
) -> Optional[dict[str, Any]]:
    if not isinstance(tool_req, Mapping):
        return None
    name = tool_req.get("name") or tool_req.get("tool")
    if not isinstance(name, str) or not name:
        return None
    for t in allowlist:
        if t.get("name") == name:
            return dict(t)
    return None
