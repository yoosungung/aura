from __future__ import annotations

import json
import os
from typing import Any, Callable

import httpx

from aura_ai.tools import TOOLS, is_high_risk, run_low_risk


class LLM:
    def __init__(self, complete: Callable[[list[dict], list[dict]], dict] | None = None) -> None:
        self.complete = complete or stub_complete

    @classmethod
    def from_env(cls) -> "LLM":
        if os.environ.get("AURA_LLM_API_KEY"):
            return cls(complete=openai_complete)
        return cls()

    def reason(self, prompt: str, ego: list[dict]) -> dict:
        messages = [
            {"role": "system", "content": "Helpdesk AI. Low-risk tools auto-run. High-risk tools need approval."},
            {"role": "user", "content": json.dumps({"message": prompt, "ego": ego}, ensure_ascii=False)},
        ]
        seen: set[str] = set()
        steps: list[dict] = []
        for _ in range(8):
            resp = self.complete(messages, TOOLS)
            calls = resp.get("tool_calls") or []
            if not calls:
                return {"action": "reply", "content": resp.get("content") or "", "steps": steps}
            call = calls[0]
            fn = call.get("function") or {}
            name = fn.get("name") or ""
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args or "{}")
            fingerprint = f"{name}:{json.dumps(args, sort_keys=True)}"
            if fingerprint in seen:
                return {"action": "reply", "content": "반복 도구 호출을 중단했습니다.", "steps": steps}
            seen.add(fingerprint)
            if is_high_risk(name):
                return {"action": "approve", "tool_name": name, "args": args, "steps": steps}
            result = run_low_risk(name, args)
            steps.append({"tool_name": name, "args": args, "result": result})
            messages.append({"role": "assistant", "content": None, "tool_calls": calls})
            messages.append(
                {
                    "role": "tool",
                    "name": name,
                    "tool_call_id": call.get("id") or name,
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )
            if name == "send_status":
                return {
                    "action": "reply",
                    "content": args.get("content") or "확인했습니다.",
                    "tool_name": name,
                    "args": args,
                    "steps": steps,
                }
        return {"action": "reply", "content": "지금은 상담원이 이어서 도와드리겠습니다.", "steps": steps}


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
