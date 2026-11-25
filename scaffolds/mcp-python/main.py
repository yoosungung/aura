"""Tenant MCP bundle scaffold (python). Upload via Admin Bundles. Entrypoint: main:factory"""


def factory(cfg, secrets_ref):
    flag = (cfg or {}).get("flag")

    async def listTools(_ctx=None):
        return {"ok": True, "tools": [{"name": "echo", "description": "echo input"}]}

    async def runTool(ctx):
        ctx = ctx or {}
        return {
            "ok": True,
            "tool": ctx.get("tool"),
            "flag": flag,
            "secrets_ref": secrets_ref,
            "input": ctx.get("input"),
        }

    return {"listTools": listTools, "runTool": runTool}
