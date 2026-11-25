"""Tenant agent bundle scaffold (python). Upload via Admin Bundles. Entrypoint: main:factory"""


def factory(cfg, secrets_ref):
    system = (cfg or {}).get("systemPrompt") or "You are a helpful agent."

    async def runTurn(input_msg=None):
        payload = input_msg or {}
        return {
            "ok": True,
            "echo": payload.get("message"),
            "system": system,
            "secrets_ref": secrets_ref,
        }

    return {"runTurn": runTurn}
