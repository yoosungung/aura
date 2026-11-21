"""Python agent_invoke handler (M3.6). Fission fastapi-env entry: main(request)."""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request, Response


def validate_invoke_task(task: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(task, dict):
        return {"ok": False, "error": "task_required"}
    if not isinstance(task.get("run_id"), str) or not task["run_id"]:
        return {"ok": False, "error": "run_id_required"}
    if not isinstance(task.get("agent"), str) or not task["agent"]:
        return {"ok": False, "error": "agent_required"}
    if not isinstance(task.get("version"), str) or not task["version"]:
        return {"ok": False, "error": "version_required"}
    principal = task.get("principal")
    if not isinstance(principal, dict):
        return {"ok": False, "error": "principal_required"}
    if not isinstance(principal.get("id"), str) or not principal["id"]:
        return {"ok": False, "error": "principal_id_required"}
    if not isinstance(principal.get("tenant_id"), str) or not principal["tenant_id"]:
        return {"ok": False, "error": "principal_tenant_id_required"}
    for k in ("bundle", "bundle_uri", "cfg", "config", "secrets"):
        if k in task and task[k] is not None:
            return {"ok": False, "error": "identifiers_only"}
    return {"ok": True, "task": task}


def assert_runtime_stamp(task: dict[str, Any], resolved_runtime: str | None) -> dict[str, Any]:
    """Stamp may be present; resolve.runtime is authoritative."""
    auth = resolved_runtime or "nodejs"
    stamp = task.get("runtime")
    if stamp is not None and stamp != auth:
        return {"ok": False, "error": "runtime_mismatch"}
    if auth != "python":
        return {"ok": False, "error": "wrong_runtime_for_python_function"}
    return {"ok": True, "runtime": auth}


async def invoke_once(task: dict[str, Any], deps: dict[str, Any] | None = None) -> dict[str, Any]:
    d = deps or {}
    v = validate_invoke_task(task)
    if not v.get("ok"):
        return {"type": "agent.invoke.error", "ok": False, "error": v["error"]}

    resolve = d.get("resolve")
    resolved_runtime = "python"
    if callable(resolve):
        resolved = await resolve(
            {
                "tenant_id": task["principal"]["tenant_id"],
                "kind": "agent",
                "name": task["agent"],
                "version": task["version"],
                "principal": task["principal"],
            }
        )
        if isinstance(resolved, dict) and resolved.get("runtime"):
            resolved_runtime = resolved["runtime"]
        if isinstance(resolved, dict) and resolved.get("secrets"):
            return {
                "type": "agent.invoke.error",
                "ok": False,
                "error": "secrets_plaintext_forbidden",
            }

    rt = assert_runtime_stamp(task, resolved_runtime)
    if not rt.get("ok"):
        return {"type": "agent.invoke.error", "ok": False, "error": rt["error"]}

    run_turn = d.get("run_turn")
    if callable(run_turn):
        result = await run_turn(task, d)
        if isinstance(result, dict):
            result.setdefault("type", "agent.invoke.done")
            result.setdefault("ok", True)
            return result

    return {
        "type": "agent.invoke.done",
        "ok": True,
        "run_id": task["run_id"],
        "runtime": "python",
        "output": {"text": "python_agent_stub"},
    }


async def main(request: Request, deps: dict[str, Any] | None = None) -> Response:
    """Fission python-fastapi-env entry — JSON body → invoke_once → JSON Response."""
    try:
        task = await request.json()
    except Exception:
        task = {}
    if not isinstance(task, dict):
        task = {}
    out = await invoke_once(task, deps)
    return Response(
        content=json.dumps(out),
        media_type="application/json",
        status_code=200,
    )
