"""Function-side LLM client — sole egress to cluster LLM Gateway (ARCHITECTURE §9.4).

Parity with client.js: assert_function_llm_egress + chat_completions (+ optional route_pin).
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import urlparse

GATEWAY_HOSTS = frozenset(
    {
        "aura-llm-gateway",
        "aura-llm-gateway.aura",
        "aura-llm-gateway.aura.svc",
        "aura-llm-gateway.aura.svc.cluster.local",
        "localhost",
        "127.0.0.1",
    }
)

PROVIDER_BLOCKLIST = frozenset(
    {
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "api.cohere.ai",
        "api.mistral.ai",
        "api.groq.com",
        "openrouter.ai",
    }
)

Transport = Callable[[dict[str, Any]], Awaitable[dict[str, Any]] | dict[str, Any]]


class LlmEgressError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code


def extract_host(url_or_host: str) -> str:
    if not url_or_host or not isinstance(url_or_host, str):
        raise LlmEgressError("url_required")
    host = url_or_host.strip()
    if "://" in host:
        parsed = urlparse(host)
        host = parsed.hostname or ""
        if not host:
            raise LlmEgressError("url_invalid")
    elif "/" in host:
        host = host.split("/", 1)[0]
    if ":" in host and not host.startswith("["):
        host = host.split(":", 1)[0]
    return host.lower()


def assert_function_llm_egress(url: str) -> None:
    host = extract_host(url)
    for blocked in PROVIDER_BLOCKLIST:
        if host == blocked or host.endswith(f".{blocked}"):
            err = LlmEgressError("provider_direct_forbidden", f"provider_direct_forbidden:{host}")
            err.host = host  # type: ignore[attr-defined]
            raise err
    if host not in GATEWAY_HOSTS:
        err = LlmEgressError("provider_direct_forbidden", f"provider_direct_forbidden:{host}")
        err.host = host  # type: ignore[attr-defined]
        raise err


class LlmGatewayClient:
    def __init__(self, *, base_url: str, transport: Transport | None = None):
        if not base_url or not isinstance(base_url, str):
            raise LlmEgressError("base_url_required")
        assert_function_llm_egress(base_url)
        self._base = base_url.rstrip("/")
        self._transport = transport

    async def chat_completions(self, req: Mapping[str, Any]) -> dict[str, Any]:
        r = dict(req or {})
        tenant_id = r.get("tenant_id")
        if not tenant_id or not isinstance(tenant_id, str):
            raise LlmEgressError("tenant_id_required")
        body: dict[str, Any] = {
            "model": r.get("model"),
            "messages": r.get("messages"),
        }
        if r.get("stream") is not None:
            body["stream"] = r["stream"]
        headers = {
            "content-type": "application/json",
            "x-aura-tenant-id": tenant_id,
        }
        pin = r.get("route_pin")
        if pin is not None and pin != "":
            headers["x-aura-route-pin"] = str(pin)
        path = "/v1/chat/completions"
        if callable(self._transport):
            out = self._transport(
                {
                    "method": "POST",
                    "url": f"{self._base}{path}",
                    "path": path,
                    "headers": headers,
                    "body": body,
                }
            )
            if isinstance(out, Awaitable):
                return await out
            return out
        import json
        import urllib.request

        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self._base}{path}",
            data=data,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request) as resp:  # noqa: S310 — egress already gated
            raw = resp.read().decode("utf-8")
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {}
            return {"status": getattr(resp, "status", 200), "body": payload}


def create_llm_gateway_client(
    *, base_url: str, transport: Transport | None = None
) -> LlmGatewayClient:
    return LlmGatewayClient(base_url=base_url, transport=transport)
