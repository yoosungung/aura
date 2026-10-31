from __future__ import annotations

import json
from typing import Any, Callable

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRetryMiddleware, ToolCallLimitMiddleware
from langchain.tools import tool
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr

from aura_ai.mcp_ops import canonical_tool_name, is_ops_high_risk, run_sync
from aura_ai.skills import Skill, SkillsMiddleware, catalog_prompt
from aura_ai.tools import TOOLS, is_high_risk

SYSTEM = "Helpdesk AI. Low-risk tools auto-run. High-risk tools need approval."


class CompletionsChatModel(BaseChatModel):
    _complete: Callable[[list[dict], list[dict]], dict] = PrivateAttr()
    _tools_schema: list[dict] = PrivateAttr(default_factory=lambda: list(TOOLS))

    def __init__(self, complete: Callable[[list[dict], list[dict]], dict], tools_schema: list[dict] | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._complete = complete
        self._tools_schema = tools_schema or list(TOOLS)

    @property
    def _llm_type(self) -> str:
        return "aura-completions"

    def bind_tools(self, tools: list, **kwargs: Any) -> CompletionsChatModel:
        return self

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        dicts = [_to_dict(m) for m in messages]
        if _should_stop(dicts):
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=""))])
        resp = self._complete(dicts, self._tools_schema)
        calls = resp.get("tool_calls") or []
        if not calls:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=resp.get("content") or ""))])
        tool_calls = []
        for i, call in enumerate(calls):
            fn = call.get("function") or {}
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args or "{}")
            tool_calls.append(
                {
                    "name": fn.get("name") or "",
                    "args": args,
                    "id": call.get("id") or str(i + 1),
                    "type": "tool_call",
                }
            )
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=resp.get("content") or "", tool_calls=tool_calls))])


class AuraHITLMiddleware(AgentMiddleware):
    def __init__(self, extra_high_risk: set[str] | None = None) -> None:
        super().__init__()
        self.pending: dict[str, Any] | None = None
        self.extra_high_risk = extra_high_risk or set()
        self.steps: list[dict] = []
        self.seen: set[str] = set()
        self.send_status: dict[str, Any] | None = None

    def after_model(self, state, runtime):
        last = state["messages"][-1]
        tcs = list(getattr(last, "tool_calls", None) or [])
        if not tcs:
            return None
        call = tcs[0]
        name = canonical_tool_name(call.get("name") or "")
        args = call.get("args") or {}
        fingerprint = f"{name}:{json.dumps(args, sort_keys=True)}"
        if fingerprint in self.seen:
            return {"messages": [AIMessage(content="반복 도구 호출을 중단했습니다.")]}
        self.seen.add(fingerprint)
        if is_ops_high_risk(name, self.extra_high_risk) or is_high_risk(name):
            self.pending = {"tool_name": name, "args": args}
            return {"messages": [AIMessage(content="")]}
        return None

    def wrap_tool_call(self, request, handler):
        blocked = self._block_high_risk(request)
        if blocked is not None:
            return blocked
        return self._record_tool(request, handler(request))

    async def awrap_tool_call(self, request, handler):
        blocked = self._block_high_risk(request)
        if blocked is not None:
            return blocked
        return self._record_tool(request, await handler(request))

    def _block_high_risk(self, request):
        name = canonical_tool_name((request.tool_call or {}).get("name") or "")
        args = (request.tool_call or {}).get("args") or {}
        if is_ops_high_risk(name, self.extra_high_risk) or is_high_risk(name):
            self.pending = {"tool_name": name, "args": args}
            return ToolMessage(
                content=json.dumps({"pending_approval": True}),
                tool_call_id=(request.tool_call or {}).get("id") or name,
                name=name,
            )
        return None

    def _record_tool(self, request, result):
        name = canonical_tool_name((request.tool_call or {}).get("name") or "")
        args = (request.tool_call or {}).get("args") or {}
        content = getattr(result, "content", result)
        parsed: Any = content
        if isinstance(content, str):
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                parsed = {"result": content}
        if name == "send_status":
            self.send_status = {"tool_name": name, "args": args, "result": parsed}
        elif name != "load_skill":
            self.steps.append({"tool_name": name, "args": args, "result": parsed if isinstance(parsed, dict) else {"result": parsed}})
        return result


@tool
def send_status(content: str) -> str:
    """고객에게 상태 안내를 보낸다. 저위험."""
    return json.dumps({"sent": True, "content": content}, ensure_ascii=False)


def reason(
    complete: Callable[[list[dict], list[dict]], dict],
    prompt: str,
    ego: list[dict],
    articles: list[dict] | None = None,
    *,
    ops_tools: list | None = None,
    skills: dict[str, Skill] | None = None,
    extra_high_risk: set[str] | None = None,
) -> dict:
    skills = skills or {}
    skill_mw = SkillsMiddleware(skills)
    hitl = AuraHITLMiddleware(extra_high_risk)
    tools = [send_status, skill_mw.tool(), *(ops_tools or [])]
    catalog = catalog_prompt(skills)
    system = SYSTEM if not catalog else f"{SYSTEM}\n{catalog}"
    agent = create_agent(
        CompletionsChatModel(complete),
        tools,
        system_prompt=system,
        middleware=[
            ToolCallLimitMiddleware(run_limit=8),
            ModelRetryMiddleware(max_retries=1, initial_delay=0, jitter=False),
            skill_mw,
            hitl,
        ],
    )
    user = json.dumps({"message": prompt, "ego": ego, "articles": articles or []}, ensure_ascii=False)
    run_sync(agent.ainvoke({"messages": [{"role": "user", "content": user}]}))
    if hitl.pending:
        return {"action": "approve", "tool_name": hitl.pending["tool_name"], "args": hitl.pending["args"], "steps": hitl.steps}
    if hitl.send_status:
        args = hitl.send_status.get("args") or {}
        return {
            "action": "reply",
            "content": args.get("content") or "확인했습니다.",
            "tool_name": "send_status",
            "args": args,
            "steps": hitl.steps + [hitl.send_status],
        }
    return {"action": "reply", "content": "지금은 상담원이 이어서 도와드리겠습니다.", "steps": hitl.steps}


def _content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(getattr(item, "text", item)))
        return "".join(parts)
    return str(content)


def _to_dict(message: BaseMessage) -> dict:
    if isinstance(message, SystemMessage):
        return {"role": "system", "content": _content_text(message.content)}
    if isinstance(message, HumanMessage):
        return {"role": "user", "content": _content_text(message.content)}
    if isinstance(message, ToolMessage):
        return {
            "role": "tool",
            "name": message.name or "",
            "tool_call_id": message.tool_call_id,
            "content": _content_text(message.content),
        }
    if isinstance(message, AIMessage):
        payload: dict[str, Any] = {"role": "assistant", "content": _content_text(message.content) or None}
        if message.tool_calls:
            payload["tool_calls"] = [
                {"id": c.get("id"), "function": {"name": c.get("name"), "arguments": c.get("args") or {}}}
                for c in message.tool_calls
            ]
        return payload
    return {"role": "user", "content": _content_text(getattr(message, "content", message))}


def _should_stop(dicts: list[dict]) -> bool:
    if not dicts:
        return False
    last = dicts[-1]
    if last.get("role") == "tool" and canonical_tool_name(last.get("name") or "") == "send_status":
        return True
    if last.get("role") == "assistant" and not last.get("tool_calls") and last.get("content") in ("", None):
        for m in reversed(dicts[:-1]):
            if m.get("role") == "assistant" and m.get("tool_calls"):
                name = canonical_tool_name(((m["tool_calls"][0].get("function") or {}).get("name")) or "")
                return is_high_risk(name)
            if m.get("role") in {"user", "tool"}:
                break
    return False
