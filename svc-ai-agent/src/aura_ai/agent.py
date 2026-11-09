from __future__ import annotations

import asyncio
import inspect
import json
import os
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from aura_ai.ego import MAX_EMBED_DIM
from aura_ai.limit import ChannelGuard, CircuitOpen, RateLimited
from aura_ai.llm import LLM, stub_embed, stub_extract
from aura_ai.mcp_ops import config_from_rows, invoke_tool, load_ops_tools
from aura_ai.skills import load_builtin_skills, merge_skills
from aura_ai.tools import is_high_risk, run_low_risk

DEFER_RECEIPT = "요청을 접수했습니다. 상담원이 확인 후 처리합니다."

current_bus: ContextVar["Bus | None"] = ContextVar("current_bus", default=None)


def new_id() -> str:
    ts = int(time.time() * 1000) & 0xFFFFFFFFFFFF
    rand_a = int.from_bytes(os.urandom(2), "big") & 0x0FFF
    rand_b = int.from_bytes(os.urandom(8), "big")
    value = (ts << 80) | (0x7 << 76) | (rand_a << 64) | (rand_b & 0x3FFFFFFFFFFFFFFF) | (0b10 << 62)
    return str(uuid.UUID(int=value))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _awaitable(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _empty_list(*_args: Any, **_kwargs: Any) -> list:
    return []


async def _empty_str(*_args: Any, **_kwargs: Any) -> str:
    return ""


async def _none(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _true(*_args: Any, **_kwargs: Any) -> bool:
    return True


class Bus:
    def publish(self, subject: str, payload: dict) -> None:
        raise NotImplementedError


class MemoryBus(Bus):
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish(self, subject: str, payload: dict) -> None:
        self.events.append((subject, payload))


class Agent:
    def __init__(
        self,
        bus: Bus,
        llm: LLM | None = None,
        guard: ChannelGuard | None = None,
        db=None,
        embed: Callable[[str], Awaitable[list[float]] | list[float]] | None = None,
    ) -> None:
        self.bus = bus
        self.llm = llm or LLM()
        self.guard = guard or ChannelGuard()
        self.db = db
        self.embed = embed or stub_embed
        self.read_ego: Callable[[str, str], Awaitable[list[dict]]] = _empty_list
        self.read_center: Callable[[str, str], Awaitable[str | None]] = _none
        self.read_messages: Callable[[str, str], Awaitable[str]] = _empty_str
        self.read_article: Callable[[str, str], Awaitable[str]] = _empty_str
        self.read_rag: Callable[[str, list[float]], Awaitable[list[dict]]] = _empty_list
        self.read_skills: Callable[[str], Awaitable[list[dict]]] = _empty_list
        self.read_mcp_servers: Callable[[str], Awaitable[list[dict]]] = _empty_list
        self.read_staff_available: Callable[[str, str], Awaitable[bool]] = _true
        self.ops_tools: list | None = None
        self._ops_key: str | None = None
        self._ops_lock = asyncio.Lock()
        self.skills_root = None

    def _bus(self) -> Bus:
        return current_bus.get() or self.bus

    async def _ops_tools_for(self, servers: list[dict]) -> list:
        config = config_from_rows(servers)
        key = json.dumps(config, sort_keys=True, default=str) if config else ""
        async with self._ops_lock:
            if self.ops_tools is not None and self._ops_key == key:
                return self.ops_tools
            try:
                tools = await load_ops_tools(config=config)
            except Exception:
                return await load_ops_tools(config=None)
            self.ops_tools = tools
            self._ops_key = key
            return tools

    async def handle_reason(self, task: dict) -> dict:
        if int(task.get("hop_count") or 0) > 5:
            return {"skipped": True, "reason": "hop"}
        prompt = task.get("content") or ""
        account = task.get("account_id", "")
        ego = await self.read_ego(account, task.get("contact_id", ""))
        articles = await self.read_rag(account, await _awaitable(self.embed(prompt)))
        skills = merge_skills(load_builtin_skills(self.skills_root), await self.read_skills(account))
        servers = await self.read_mcp_servers(account)
        extra = set()
        for row in servers:
            extra.update(row.get("high_risk_tools") or [])
        ops_tools = await self._ops_tools_for(servers)
        decision = await self.llm.reason(
            prompt, ego, articles, ops_tools=ops_tools, skills=skills, extra_high_risk=extra
        )
        for step in decision.get("steps") or []:
            name = step.get("tool_name") or ""
            if name and name != decision.get("tool_name"):
                self._tool_event(task, name, step.get("args") or {}, step.get("result") or {}, requires=False, success=True)
        if decision.get("action") == "approve":
            return await self._approval_card(task, decision)
        return await self._auto_reply(task, decision)

    async def handle_execute(self, task: dict) -> dict:
        name = task.get("tool_name") or ""
        args = task.get("input_args") or {}
        if name == "send_status":
            result = run_low_risk(name, args)
        else:
            ops_tools = await self._ops_tools_for(await self.read_mcp_servers(task.get("account_id", "")))
            result = await invoke_tool(ops_tools, name, args)
        content = args.get("content") or f"{name} 처리했습니다."
        if is_high_risk(name):
            content = f"{name} 승인이 반영되었습니다."
        self._tool_event(task, name, args, result, requires=False, success=True, approved_by=task.get("approved_by"))
        return await self._outbound_reply(task, content)

    async def handle_extract(self, task: dict) -> dict:
        transcript = await self.read_messages(task.get("account_id", ""), task.get("conversation_id", ""))
        extracted = stub_extract(transcript)
        account = task.get("account_id")
        inbox = task.get("inbox_id") or str(uuid.UUID(int=0))
        conv = task.get("conversation_id")
        contact = task.get("contact_id")
        center = await self.read_center(account, contact) or new_id()
        nodes = [
            {
                "id": center,
                "entity_type": "Customer",
                "name": "Customer",
                "external_ref_id": contact,
                "properties": {},
            }
        ]
        edges = []
        for node, edge in zip(extracted.get("nodes") or [], extracted.get("edges") or []):
            nid = new_id()
            nodes.append({"id": nid, **node, "external_ref_id": node.get("external_ref_id", "")})
            edges.append(
                {
                    "id": new_id(),
                    "source_node_id": center,
                    "target_node_id": nid,
                    "relation_type": edge.get("relation_type") or "EXPERIENCED",
                    "weight": 1.0,
                    "confidence": 0.8,
                    "source_conversation_id": conv,
                }
            )
        env = self._envelope(account, inbox, conv, "ontology_extracted", {"nodes": nodes, "edges": edges}, task=task)
        self._bus().publish(f"helpdesk.events.{account}.{inbox}.{conv}.ontology_extracted", env)
        return env

    async def handle_embed(self, task: dict) -> dict:
        text = await self.read_article(task.get("account_id", ""), task.get("owner_id", ""))
        vector = await _awaitable(self.embed(text))
        if not (1 <= len(vector) <= MAX_EMBED_DIM):
            return {"skipped": True, "reason": "dim"}
        account = task.get("account_id")
        nil_id = str(uuid.UUID(int=0))
        env = self._envelope(
            account,
            nil_id,
            nil_id,
            "embedding_upsert",
            {
                "owner_type": task.get("owner_type") or "article",
                "owner_id": task.get("owner_id"),
                "model": os.environ.get("AURA_EMBEDDING_MODEL", "text-embedding-3-small"),
                "version": 1,
                "embedding": vector,
            },
            task=task,
        )
        self._bus().publish(f"helpdesk.events.{account}.{nil_id}.{nil_id}.embedding_upsert", env)
        return env

    async def _approval_card(self, task: dict, decision: dict) -> dict:
        exec_id = new_id()
        name = decision["tool_name"]
        args = decision.get("args") or {}
        summary = f"{name} 실행"
        self._tool_event(task, name, args, {}, requires=True, success=False, execution_id=exec_id)
        content = json.dumps(
            {"kind": "tool_approval", "execution_id": exec_id, "tool_name": name, "summary": summary, "args": args},
            ensure_ascii=False,
        )
        available = await self.read_staff_available(task.get("account_id", ""), task.get("inbox_id", ""))
        if available:
            return self._message(task, content, content_type="form", sender_type="AgentBot", message_type=3, private=False)
        self._message(task, content, content_type="form", sender_type="AgentBot", message_type=3, private=True)
        return await self._outbound_reply(task, DEFER_RECEIPT)

    async def _auto_reply(self, task: dict, decision: dict) -> dict:
        content = decision.get("content") or "확인했습니다."
        if decision.get("tool_name"):
            self._tool_event(task, decision["tool_name"], decision.get("args") or {}, {"ok": True}, requires=False, success=True)
        return await self._outbound_reply(task, content)

    async def _outbound_reply(self, task: dict, content: str) -> dict:
        channel = task.get("channel_type") or "web"
        try:
            await self.guard.allow(channel)
        except (RateLimited, CircuitOpen):
            return {"skipped": True, "reason": "limited"}
        env = self._message(task, content, content_type="text", sender_type="AgentBot", message_type=1, private=False)
        if channel in {"email", "kakao"}:
            self._bus().publish(
                f"helpdesk.tasks.outbound.{channel}",
                {
                    "account_id": task.get("account_id"),
                    "inbox_id": task.get("inbox_id"),
                    "conversation_id": task.get("conversation_id"),
                    "message_id": env["id"],
                    "content": content,
                    "session_live": True,
                },
            )
        await self.guard.success(channel)
        return env

    def _tool_event(
        self,
        task: dict,
        name: str,
        args: dict,
        result: dict,
        *,
        requires: bool,
        success: bool,
        execution_id: str | None = None,
        approved_by: str | None = None,
    ) -> None:
        env = self._envelope(
            task.get("account_id"),
            task.get("inbox_id"),
            task.get("conversation_id"),
            "tool_execution",
            {
                "tool_name": name,
                "input_args": args,
                "output_result": result,
                "is_success": success,
                "requires_approval": requires,
                "approved_by": approved_by,
            },
            event_id=execution_id,
            task=task,
        )
        account, inbox, conv = task.get("account_id"), task.get("inbox_id"), task.get("conversation_id")
        self._bus().publish(f"helpdesk.events.{account}.{inbox}.{conv}.tool_execution", env)

    def _message(
        self,
        task: dict,
        content: str,
        *,
        content_type: str,
        sender_type: str,
        message_type: int,
        private: bool = False,
    ) -> dict:
        env = self._envelope(
            task.get("account_id"),
            task.get("inbox_id"),
            task.get("conversation_id"),
            "message_created",
            {
                "content": content,
                "message_type": message_type,
                "private": private,
                "status": "sent",
                "content_type": content_type,
                "sender_type": sender_type,
                "sender_id": task.get("inbox_id"),
                "contact_id": task.get("contact_id"),
                "contact_inbox_id": task.get("contact_inbox_id"),
                "attachments": [],
            },
            task=task,
        )
        account, inbox, conv = task.get("account_id"), task.get("inbox_id"), task.get("conversation_id")
        self._bus().publish(f"helpdesk.events.{account}.{inbox}.{conv}.message_created", env)
        self._bus().publish(
            f"helpdesk.realtime.{account}.{conv}.updated",
            {"type": "event", "event": "message.created", "account_id": account, "inbox_id": inbox, "conversation_id": conv, "message": env},
        )
        return env

    def _envelope(
        self,
        account: str,
        inbox: str,
        conv: str,
        typ: str,
        payload: dict[str, Any],
        event_id: str | None = None,
        task: dict | None = None,
    ) -> dict:
        src = task or {}
        hop = int(src.get("hop_count") or 0) + 1
        env = {
            "id": event_id or new_id(),
            "schema_version": 1,
            "type": typ,
            "occurred_at": now(),
            "account_id": account,
            "inbox_id": inbox,
            "conversation_id": conv,
            "trace_id": src.get("trace_id") or new_id().replace("-", ""),
            "hop_count": hop,
            "payload": payload,
        }
        if src.get("trigger_message_id"):
            env["causation_id"] = src["trigger_message_id"]
        return env
