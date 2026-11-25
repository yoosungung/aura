"""Tenant MCP bundle scaffold (python). Zip-upload without .venv. Entrypoint: main:factory"""

from lib.meta import TAG


def factory(cfg, secrets_ref):
    flag = (cfg or {}).get("flag")

    async def listTools(_ctx=None):
        return {"ok": True, "tools": [{"name": "echo", "description": "echo input"}]}

    async def runTool(ctx):
        ctx = ctx or {}
        return {
            "ok": True,
            "tag": TAG,
            "tool": ctx.get("tool"),
            "flag": flag,
            "secrets_ref": secrets_ref,
            "input": ctx.get("input"),
        }

    return {"listTools": listTools, "runTool": runTool}
