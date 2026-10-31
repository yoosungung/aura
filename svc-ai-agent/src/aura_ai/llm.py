from __future__ import annotations

import json
import os
from typing import Any, Callable

import httpx

from aura_ai.harness import reason as harness_reason
from aura_ai.skills import Skill
from aura_ai.tools import TOOLS


class LLM:
    def __init__(self, complete: Callable[[list[dict], list[dict]], dict] | None = None) -> None:
        self.complete = complete or stub_complete

    @classmethod
    def from_env(cls) -> "LLM":
        if os.environ.get("AURA_LLM_API_KEY"):
            return cls(complete=openai_complete)
        return cls()

    def reason(
        self,
        prompt: str,
        ego: list[dict],
        articles: list[dict] | None = None,
        ops_tools: list | None = None,
        skills: dict[str, Skill] | None = None,
        extra_high_risk: set[str] | None = None,
    ) -> dict:
        return harness_reason(
            self.complete,
            prompt,
            ego,
            articles,
            ops_tools=ops_tools,
            skills=skills,
            extra_high_risk=extra_high_risk,
        )


def stub_complete(messages: list[dict], _tools: list[dict]) -> dict:
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


def stub_embed(_text: str) -> list[float]:
    return [0.01] * 1536


def openai_complete(messages: list[dict], tools: list[dict]) -> dict:
    base = os.environ.get("AURA_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("AURA_LLM_API_KEY", "")
    model = os.environ.get("AURA_LLM_MODEL", "gpt-4o-mini")
    res = httpx.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "messages": messages, "tools": tools},
        timeout=60,
    )
    res.raise_for_status()
    msg = (res.json().get("choices") or [{}])[0].get("message") or {}
    return {"content": msg.get("content") or "", "tool_calls": msg.get("tool_calls") or []}


def openai_embed(text: str) -> list[float]:
    base = os.environ.get("AURA_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("AURA_LLM_API_KEY", "")
    model = os.environ.get("AURA_EMBEDDING_MODEL", "text-embedding-3-small")
    res = httpx.post(
        f"{base}/embeddings",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "input": text},
        timeout=60,
    )
    res.raise_for_status()
    vec = ((res.json().get("data") or [{}])[0]).get("embedding") or []
    return [float(x) for x in vec]


def embed_from_env() -> Callable[[str], list[float]]:
    if os.environ.get("AURA_LLM_API_KEY"):
        return openai_embed
    return stub_embed
