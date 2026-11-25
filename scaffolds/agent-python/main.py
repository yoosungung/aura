"""Tenant agent bundle scaffold (python). Zip-upload without .venv. Entrypoint: main:factory"""

from lib.echo import TAG


def factory(cfg, secrets_ref):
    system = (cfg or {}).get("systemPrompt") or "You are a helpful agent."

    async def runTurn(input_msg=None):
        payload = input_msg or {}
        return {
            "ok": True,
            "tag": TAG,
            "echo": payload.get("message"),
            "system": system,
            "secrets_ref": secrets_ref,
        }

    return {"runTurn": runTurn}
