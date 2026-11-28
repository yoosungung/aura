"""LangChain-facing chat model that only talks to Aura LLM Gateway (§9.4).

Parity with nodejs/llm-gateway-model.js. aura-auto re-sends X-Aura-Route-Pin (M5.1).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

AUTO_MODEL = "aura-auto"


def _load_gateway_client():
    here = Path(__file__).resolve().parent
    candidates = [
        here / "llm_gateway_client.py",  # archive layout
        here.parents[1] / "llm-gateway" / "clients" / "client.py",  # monorepo
    ]
    for path in candidates:
        if path.is_file():
            spec = importlib.util.spec_from_file_location("aura_llm_gateway_client", path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise RuntimeError("llm_gateway_client_missing")


_client_mod = _load_gateway_client()
assert_function_llm_egress = _client_mod.assert_function_llm_egress
create_llm_gateway_client = _client_mod.create_llm_gateway_client
LlmEgressError = _client_mod.LlmEgressError


class GatewayChatModel:
    def __init__(
        self,
        *,
        base_url: str,
        tenant_id: str,
        model: str = "aura-default",
        transport: Callable[[dict[str, Any]], Any] | None = None,
        route_pin: str | None = None,
    ):
        if not base_url or not isinstance(base_url, str):
            raise LlmEgressError("base_url_required")
        assert_function_llm_egress(base_url)
        if not tenant_id or not isinstance(tenant_id, str):
            raise LlmEgressError("tenant_id_required")
        self._client = create_llm_gateway_client(base_url=base_url, transport=transport)
        self.model = model or "aura-default"
        self.tenant_id = tenant_id
        self._aura_gateway = True
        self._route_pin = str(route_pin) if route_pin else None

    def get_route_pin(self) -> str | None:
        return self._route_pin

    async def invoke(self, messages: list[Mapping[str, Any]] | None) -> dict[str, Any]:
        req: dict[str, Any] = {
            "tenant_id": self.tenant_id,
            "model": self.model,
            "messages": list(messages or []),
        }
        if self.model == AUTO_MODEL and self._route_pin:
            req["route_pin"] = self._route_pin
        res = await self._client.chat_completions(req)
        body = res.get("body") if isinstance(res, dict) else None
        if (
            self.model == AUTO_MODEL
            and isinstance(body, dict)
            and isinstance(body.get("aura"), dict)
            and isinstance(body["aura"].get("route"), dict)
            and body["aura"]["route"].get("tier")
        ):
            self._route_pin = str(body["aura"]["route"]["tier"])
        choice = ""
        if isinstance(body, dict):
            choices = body.get("choices")
            if isinstance(choices, list) and choices:
                msg = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                    choice = msg["content"]
        return {"content": choice, "raw": res}


def create_gateway_chat_model(
    *,
    base_url: str,
    tenant_id: str,
    model: str = "aura-default",
    transport: Callable[[dict[str, Any]], Any] | None = None,
    route_pin: str | None = None,
) -> GatewayChatModel:
    return GatewayChatModel(
        base_url=base_url,
        tenant_id=tenant_id,
        model=model,
        transport=transport,
        route_pin=route_pin,
    )
