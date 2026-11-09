from __future__ import annotations

import json
import os
from typing import Any, Awaitable, Callable

import httpx

CompleteFn = Callable[[list[dict], list[dict]], Awaitable[dict] | dict]
EmbedFn = Callable[[str], Awaitable[list[float]] | list[float]]


class LLM:
    def __init__(self, complete: CompleteFn | None = None) -> None:
        self.complete = complete or stub_complete

    @classmethod
    def from_env(cls, client: httpx.AsyncClient | None = None) -> "LLM":
        if os.environ.get("AURA_LLM_API_KEY"):
            if client is None:
                raise ValueError("AsyncClient required when AURA_LLM_API_KEY is set")

            async def complete(messages: list[dict], tools: list[dict]) -> dict:
                return await openai_complete(messages, tools, client=client)

            return cls(complete=complete)
        return cls()


async def stub_complete(messages: list[dict], _tools: list[dict]) -> dict:
    text = ""
    for m in messages:
        if m.get("role") == "user":
            text = str(m.get("content") or "")
    lowered = text.lower()
    if any(k in text for k in ("환불", "취소", "refund", "cancel")):
        return {
            "tool_calls": [
                {
                    "function": {
                        "name": "refund" if "환불" in text or "refund" in lowered else "cancel_subscription",
                        "arguments": {"amount": 45000, "reason": "고객 요청"},
                    }
                }
            ]
        }
    return {
        "tool_calls": [
            {"function": {"name": "send_status", "arguments": {"content": "확인했습니다. 바로 도와드리겠습니다."}}}
        ]
    }


def stub_extract(transcript: str) -> dict[str, Any]:
    nodes = []
    edges = []
    if any(k in transcript for k in ("결제", "환불", "오류")):
        nodes.append({"entity_type": "PainPoint", "name": "결제 오류", "properties": {}})
        edges.append({"relation_type": "EXPERIENCED"})
    if "카카오" in transcript:
        nodes.append({"entity_type": "Preference", "name": "카카오", "properties": {}})
        edges.append({"relation_type": "PREFERS"})
    return {"nodes": nodes, "edges": edges}


async def stub_embed(_text: str) -> list[float]:
    return [0.01] * 1536


async def openai_complete(messages: list[dict], tools: list[dict], *, client: httpx.AsyncClient) -> dict:
    base = os.environ.get("AURA_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("AURA_LLM_API_KEY", "")
    model = os.environ.get("AURA_LLM_MODEL", "gpt-4o-mini")
    res = await client.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "messages": messages, "tools": tools},
        timeout=60,
    )
    res.raise_for_status()
    msg = (res.json().get("choices") or [{}])[0].get("message") or {}
    return {"content": msg.get("content") or "", "tool_calls": msg.get("tool_calls") or []}


async def openai_embed(text: str, *, client: httpx.AsyncClient) -> list[float]:
    base = os.environ.get("AURA_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("AURA_LLM_API_KEY", "")
    model = os.environ.get("AURA_EMBEDDING_MODEL", "text-embedding-3-small")
    res = await client.post(
        f"{base}/embeddings",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "input": text},
        timeout=60,
    )
    res.raise_for_status()
    vec = ((res.json().get("data") or [{}])[0]).get("embedding") or []
    return [float(x) for x in vec]


def embed_from_env(client: httpx.AsyncClient | None = None) -> EmbedFn:
    if os.environ.get("AURA_LLM_API_KEY"):
        if client is None:
            raise ValueError("AsyncClient required when AURA_LLM_API_KEY is set")

        async def embed(text: str) -> list[float]:
            return await openai_embed(text, client=client)

        return embed
    return stub_embed
