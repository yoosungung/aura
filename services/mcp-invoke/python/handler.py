"""Python mcp_invoke handler (M3.6). Fission fastapi-env entry: main(request)."""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request, Response

from factory import open_factory


def validate_mcp_request(req: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(req, dict):
        return {"ok": False, "error": "request_required"}
    if not isinstance(req.get("server"), str) or not req["server"]:
        return {"ok": False, "error": "server_required"}
    if not isinstance(req.get("version"), str) or not req["version"]:
        req["version"] = "1.0.0"
    action = req.get("action") or "call"
    if action not in ("call", "list"):
        return {"ok": False, "error": "action_invalid"}
    req["action"] = action
    if action == "call" and (not isinstance(req.get("tool"), str) or not req["tool"]):
        return {"ok": False, "error": "tool_required"}
    principal = req.get("principal")
    if not isinstance(principal, dict):
        return {"ok": False, "error": "principal_required"}
    if not isinstance(principal.get("id"), str) or not principal["id"]:
        return {"ok": False, "error": "principal_id_required"}
    if not isinstance(principal.get("tenant_id"), str) or not principal["tenant_id"]:
        return {"ok": False, "error": "principal_tenant_id_required"}
    for k in ("bundle", "bundle_uri", "cfg", "config", "secrets"):
        if k in req and req[k] is not None:
            return {"ok": False, "error": "identifiers_only"}
    return {"ok": True, "req": req}


def assert_runtime_stamp(req: dict[str, Any], resolved_runtime: str | None) -> dict[str, Any]:
    auth = resolved_runtime or "nodejs"
    stamp = req.get("runtime")
    if stamp is not None and stamp != auth:
        return {"ok": False, "error": "runtime_mismatch"}
    if auth != "python":
        return {"ok": False, "error": "wrong_runtime_for_python_function"}
    return {"ok": True, "runtime": auth}


async def invoke_tool_once(req: dict[str, Any], deps: dict[str, Any] | None = None) -> dict[str, Any]:
    d = deps or {}
    v = validate_mcp_request(req)
    if not v.get("ok"):
        return {"type": "mcp.invoke.error", "ok": False, "error": v["error"]}

    resolve = d.get("resolve")
    resolved: dict[str, Any] | None = None
    resolved_runtime = "python"
    cfg: dict[str, Any] = {}
    if callable(resolve):
        resolved = await resolve(
            {
                "tenant_id": req["principal"]["tenant_id"],
                "kind": "mcp",
                "name": req["server"],
                "version": req["version"],
                "principal": req["principal"],
            }
        )
        if isinstance(resolved, dict) and resolved.get("secrets"):
            return {
                "type": "mcp.invoke.error",
                "ok": False,
                "error": "secrets_plaintext_forbidden",
            }
        if isinstance(resolved, dict):
            resolved_runtime = resolved.get("runtime") or "python"
            cfg = resolved.get("cfg") or {}

    rt = assert_runtime_stamp(req, resolved_runtime)
    if not rt.get("ok"):
        return {"type": "mcp.invoke.error", "ok": False, "error": rt["error"]}

    source = resolved.get("source") if isinstance(resolved, dict) else {}
    secrets_ref = resolved.get("secrets_ref") if isinstance(resolved, dict) else None
    load_bundle = d.get("load_bundle")
    if not callable(load_bundle):
        import importlib
        import sys
        from pathlib import Path

        here = Path(__file__).resolve().parent
        for cand in (here, here.parent.parent / "object-store"):
            if (cand / "bundle_cache.py").exists():
                p = str(cand)
                if p not in sys.path:
                    sys.path.insert(0, p)
                break
        bundle_cache = importlib.import_module("bundle_cache")

        async def load_bundle(src, _cache=bundle_cache, _tenant=req["principal"]["tenant_id"]):
            return await _cache.load_cached_bundle(
                src,
                {
                    "tenant_id": _tenant,
                    "fetch": d.get("object_fetch"),
                    "endpoint": d.get("object_endpoint"),
                    "region": d.get("object_region"),
                    "access_key_id": d.get("object_access_key_id"),
                    "secret_access_key": d.get("object_secret_access_key"),
                    "cache": d.get("bundle_cache"),
                    "env": d.get("object_env"),
                },
            )

    try:
        fac = await open_factory(
            cfg,
            {
                "source": source or {},
                "secrets_ref": secrets_ref,
                "fetch": d.get("fetch"),
                "load_bundle": load_bundle,
                "list_tools": d.get("list_tools"),
                "run_tool": d.get("run_tool"),
            },
        )
    except RuntimeError as err:
        return {"type": "mcp.invoke.error", "ok": False, "error": str(err)}

    ctx = {
        "server": req["server"],
        "version": req["version"],
        "tool": req.get("tool"),
        "arguments": req.get("arguments") if isinstance(req.get("arguments"), dict) else {},
        "principal": req["principal"],
        "cfg": cfg,
        "secrets_ref": secrets_ref,
    }
    if req["action"] == "list":
        listed = await fac["listTools"](ctx)
        tools = listed.get("tools") if isinstance(listed, dict) else listed
        return {
            "type": "mcp.invoke.done",
            "ok": True,
            "action": "list",
            "tools": tools or [],
            "runtime": "python",
        }

    result = await fac["runTool"](ctx)
    return {
        "type": "mcp.tool.done",
        "ok": True,
        "action": "call",
        "tool": req.get("tool"),
        "result": result,
        "runtime": "python",
    }


async def main(request: Request, deps: dict[str, Any] | None = None) -> Response:
    """Fission python-fastapi-env entry — JSON body → invoke_tool_once → JSON Response."""
    try:
        req = await request.json()
    except Exception:
        req = {}
    if not isinstance(req, dict):
        req = {}
    out = await invoke_tool_once(req, deps)
    return Response(
        content=json.dumps(out),
        media_type="application/json",
        status_code=200,
    )
