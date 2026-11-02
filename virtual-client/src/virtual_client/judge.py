from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any


def coerce_judge_tool_calls(response: Any, tools: list, tool_choice: Any) -> Any:
    if not getattr(response, "choices", None):
        return response
    message = response.choices[0].message
    if getattr(message, "tool_calls", None):
        return response
    names = [((t.get("function") or {}).get("name") or "") for t in tools]
    names = [n for n in names if n]
    content = (getattr(message, "content", None) or "").strip()
    parsed = _parse_tool(content, names)
    if parsed is None:
        parsed = _fallback(names, tools, tool_choice, content)
    if parsed is None:
        return response
    name, args = parsed
    message.tool_calls = [
        SimpleNamespace(
            id="coerce-1",
            function=SimpleNamespace(name=name, arguments=json.dumps(args, ensure_ascii=False)),
        )
    ]
    return response


def _parse_tool(content: str, names: list[str]) -> tuple[str, dict] | None:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    if text in names:
        return text, {}
    blob = _json_blob(text)
    if not isinstance(blob, dict):
        return None
    name = blob.get("name") or (blob.get("function") or {}).get("name")
    args = blob.get("arguments") or blob.get("parameters") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except json.JSONDecodeError:
            args = {}
    if name in names:
        return name, args if isinstance(args, dict) else {}
    if "criteria" in blob and "finish_test" in names:
        return "finish_test", blob
    return None


def _json_blob(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None


def _fallback(names: list[str], tools: list, tool_choice: Any, content: str) -> tuple[str, dict] | None:
    pinned = None
    if isinstance(tool_choice, dict):
        pinned = (tool_choice.get("function") or {}).get("name")
    if pinned == "finish_test" or (pinned is None and names == ["finish_test"]):
        return "finish_test", _inconclusive(tools, content)
    if pinned in names:
        return pinned, {}
    if "continue_test" in names:
        return "continue_test", {}
    if "finish_test" in names:
        return "finish_test", _inconclusive(tools, content)
    return None


def _inconclusive(tools: list, content: str) -> dict:
    reason = content or "로컬 모델이 finish_test tool call을 내지 않음"
    props = (
        (((tools or [{}])[0].get("function") or {}).get("parameters") or {})
        .get("properties", {})
        .get("criteria", {})
        .get("properties")
        or {}
    )
    criteria = {
        key: {
            "requirement": (spec or {}).get("description") or key,
            "reasoning": reason,
            "status": "inconclusive",
        }
        for key, spec in props.items()
    }
    return {"criteria": criteria, "reasoning": reason}
