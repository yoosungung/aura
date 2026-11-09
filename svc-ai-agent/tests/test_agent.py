import uuid

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from aura_ai.agent import DEFER_RECEIPT, Agent, MemoryBus, new_id
from aura_ai.ego import bind_agent, staff_available
from aura_ai.hours import open_now
from aura_ai.limit import ChannelGuard, CircuitOpen
from aura_ai.llm import LLM, openai_complete, stub_complete
from aura_ai.skills import load_builtin_skills, merge_skills
from aura_ai.tools import TOOLS

WEEKDAY_HOURS = {
    "timezone": "Asia/Seoul",
    "week": {
        "mon": [["09:00", "18:00"]],
        "tue": [["09:00", "18:00"]],
        "wed": [["09:00", "18:00"]],
        "thu": [["09:00", "18:00"]],
        "fri": [["09:00", "18:00"]],
        "sat": [],
        "sun": [],
    },
}


def task(**extra):
    base = {
        "account_id": "a",
        "inbox_id": "i",
        "conversation_id": "c",
        "contact_id": "p",
        "contact_inbox_id": "ci",
        "channel_type": "web",
        "content": "배송이 어디인가요",
    }
    base.update(extra)
    return base


async def test_reason_increments_hop_and_sets_causation():
    bus = MemoryBus()
    agent = Agent(bus)
    env = await agent.handle_reason(task(hop_count=0, trigger_message_id="m1", trace_id="abc"))
    assert env["hop_count"] == 1
    assert env["causation_id"] == "m1"
    assert env["trace_id"] == "abc"


async def test_reason_drops_when_hop_exceeds_five():
    bus = MemoryBus()
    agent = Agent(bus)
    env = await agent.handle_reason(task(hop_count=6))
    assert env["skipped"] is True
    assert bus.events == []


async def test_low_risk_sends_outbound_message():
    bus = MemoryBus()
    agent = Agent(bus)
    env = await agent.handle_reason(task())
    types = [payload["type"] for _, payload in bus.events if isinstance(payload, dict) and "type" in payload]
    assert "message_created" in types
    assert env["payload"]["content_type"] == "text"
    assert env["payload"]["sender_type"] == "AgentBot"


async def test_execute_calls_ops_mcp():
    bus = MemoryBus()
    agent = Agent(bus)
    env = await agent.handle_execute(task(tool_name="refund", input_args={"amount": 45000, "reason": "고객 요청"}))
    assert env["payload"]["content_type"] == "text"
    types = [payload["type"] for _, payload in bus.events if isinstance(payload, dict)]
    assert "tool_execution" in types
    tool = next(payload for _, payload in bus.events if isinstance(payload, dict) and payload.get("type") == "tool_execution")
    assert tool["payload"]["output_result"].get("executed") is True
    assert tool["payload"]["output_result"].get("amount") == 45000


async def test_high_risk_emits_approval_card():
    bus = MemoryBus()
    agent = Agent(bus)
    env = await agent.handle_reason(task(content="환불 해주세요"))
    assert env["payload"]["content_type"] == "form"
    assert env["payload"]["private"] is False
    card = __import__("json").loads(env["payload"]["content"])
    assert card["kind"] == "tool_approval"
    assert card["tool_name"] == "refund"
    assert any(payload.get("type") == "tool_execution" for _, payload in bus.events)


async def test_high_risk_defers_when_staff_unavailable():
    bus = MemoryBus()
    agent = Agent(bus)

    async def unavailable(*_):
        return False

    agent.read_staff_available = unavailable
    env = await agent.handle_reason(task(content="환불 해주세요"))
    assert env["payload"]["content_type"] == "text"
    assert env["payload"]["private"] is False
    assert env["payload"]["content"] == DEFER_RECEIPT
    messages = [p for _, p in bus.events if isinstance(p, dict) and p.get("type") == "message_created"]
    form = next(p for p in messages if p["payload"]["content_type"] == "form")
    assert form["payload"]["private"] is True
    card = __import__("json").loads(form["payload"]["content"])
    assert card["kind"] == "tool_approval"
    assert card["tool_name"] == "refund"
    assert any(p.get("type") == "tool_execution" for _, p in bus.events if isinstance(p, dict))
    assert not any(
        isinstance(p, dict) and p.get("type") == "tool_execution" and p["payload"].get("is_success")
        for _, p in bus.events
    )


def test_open_now_matches_go_hours():
    loc = ZoneInfo("Asia/Seoul")
    sat = datetime(2026, 1, 3, 10, 0, tzinfo=loc)
    fri = datetime(2026, 1, 2, 10, 0, tzinfo=loc)
    assert open_now(sat, True, WEEKDAY_HOURS) is False
    assert open_now(fri, True, WEEKDAY_HOURS) is True
    assert open_now(sat, False, WEEKDAY_HOURS) is True


async def test_staff_available_requires_hours_and_online():
    class FakeConn:
        def __init__(self, enabled, hours, online):
            self.enabled = enabled
            self.hours = hours
            self.online = online
            self.calls = []

        async def execute(self, sql, args=None):
            self.calls.append(sql)
            self._sql = sql
            return self

        async def fetchone(self):
            if "FROM inboxes" in self._sql:
                return (self.enabled, self.hours)
            return (self.online,)

    fri = datetime(2026, 1, 2, 10, 0, tzinfo=ZoneInfo("Asia/Seoul"))
    assert await staff_available(FakeConn(True, WEEKDAY_HOURS, 1), "i", now=fri) is True
    assert await staff_available(FakeConn(True, WEEKDAY_HOURS, 0), "i", now=fri) is False
    sat = datetime(2026, 1, 3, 10, 0, tzinfo=ZoneInfo("Asia/Seoul"))
    assert await staff_available(FakeConn(True, WEEKDAY_HOURS, 1), "i", now=sat) is False


async def test_extract_writes_ontology_event():
    bus = MemoryBus()
    agent = Agent(bus)

    async def messages(*_):
        return "결제 오류로 문의"

    agent.read_messages = messages
    env = await agent.handle_extract(task())
    assert env["type"] == "ontology_extracted"
    assert any(n["entity_type"] == "PainPoint" for n in env["payload"]["nodes"])


async def test_embed_has_1536_dims(monkeypatch):
    monkeypatch.delenv("AURA_EMBEDDING_MODEL", raising=False)
    bus = MemoryBus()
    agent = Agent(bus)
    env = await agent.handle_embed({"account_id": "a", "owner_type": "article", "owner_id": "art"})
    assert len(env["payload"]["embedding"]) == 1536
    assert env["payload"]["model"] == "text-embedding-3-small"


async def test_embed_keeps_model_dim(monkeypatch):
    monkeypatch.setenv("AURA_EMBEDDING_MODEL", "embeddinggemma-2:270m")
    bus = MemoryBus()

    async def embed768(_text):
        return [0.01] * 768

    agent = Agent(bus, embed=embed768)
    env = await agent.handle_embed({"account_id": "a", "owner_type": "article", "owner_id": "art"})
    assert env.get("skipped") is None
    assert len(env["payload"]["embedding"]) == 768
    assert env["payload"]["model"] == "embeddinggemma-2:270m"


async def test_embed_drops_empty_vector():
    bus = MemoryBus()

    async def empty(_text):
        return []

    agent = Agent(bus, embed=empty)
    env = await agent.handle_embed({"account_id": "a", "owner_type": "article", "owner_id": "art"})
    assert env["skipped"] is True
    assert env["reason"] == "dim"


async def test_guard_opens_circuit():
    g = ChannelGuard(rps=100, burst=100, failures_needed=2, open_for=30)
    g.failure("email")
    g.failure("email")
    try:
        await g.allow("email")
        raised = False
    except CircuitOpen:
        raised = True
    assert raised


def test_new_id_is_uuid7():
    assert uuid.UUID(new_id()).version == 7


async def test_reason_passes_rag_articles():
    seen = []

    async def complete(messages, _tools):
        seen.append(messages)
        return {"tool_calls": [{"function": {"name": "send_status", "arguments": {"content": "영업일 2일"}}}]}

    bus = MemoryBus()
    agent = Agent(bus, LLM(complete))

    async def rag(*_):
        return [{"title": "배송 안내", "body": "영업일 2일"}]

    agent.read_rag = rag
    await agent.handle_reason(task())
    assert "배송 안내" in seen[0][1]["content"]


async def test_search_articles_sets_hnsw_and_filters_model():
    class FakeConn:
        def __init__(self):
            self.calls = []

        async def execute(self, sql, args=None):
            self.calls.append((sql, args))
            return self

        async def fetchall(self):
            return []

    conn = FakeConn()
    from aura_ai.ego import search_articles

    await search_articles(conn, [0.01] * 1536, model="text-embedding-3-small")
    assert any("hnsw.ef_search = 40" in sql for sql, _ in conn.calls)
    assert any("hnsw.iterative_scan = relaxed_order" in sql for sql, _ in conn.calls)
    select, args = next((sql, a) for sql, a in conn.calls if sql and "<=>" in sql)
    assert "owner_type = 'article'" in select
    assert "e.model" in select
    assert "vector_dims(e.embedding)" in select
    assert "halfvec(1536)" in select
    assert args[0] == "text-embedding-3-small"
    assert args[2] == 1536


async def test_search_articles_768_uses_matching_cast():
    class FakeConn:
        def __init__(self):
            self.calls = []

        async def execute(self, sql, args=None):
            self.calls.append((sql, args))
            return self

        async def fetchall(self):
            return []

    conn = FakeConn()
    from aura_ai.ego import search_articles

    await search_articles(conn, [0.01] * 768, model="embeddinggemma-2:270m")
    select, args = next((sql, a) for sql, a in conn.calls if sql and "<=>" in sql)
    assert "halfvec(768)" in select
    assert "vector_dims(e.embedding)" in select
    assert args[0] == "embeddinggemma-2:270m"
    assert args[2] == 768


async def test_search_articles_empty_vector_skips():
    class FakeConn:
        async def execute(self, sql, args=None):
            raise AssertionError("should not query")

    from aura_ai.ego import search_articles

    assert await search_articles(FakeConn(), []) == []


async def test_reason_passes_ego_and_lookup_result():
    seen = []

    async def complete(messages, _tools):
        seen.append(messages)
        if len(seen) == 1:
            return {"tool_calls": [{"id": "1", "function": {"name": "lookup_order", "arguments": {"order_id": "9"}}}]}
        return {"tool_calls": [{"function": {"name": "send_status", "arguments": {"content": "주문은 paid"}}}]}

    bus = MemoryBus()
    agent = Agent(bus, LLM(complete))

    async def ego(*_):
        return [{"name": "결제 오류", "entity_type": "PainPoint"}]

    agent.read_ego = ego
    env = await agent.handle_reason(task())
    assert "결제 오류" in seen[0][1]["content"]
    assert "paid" in seen[1][-1]["content"]
    assert env["payload"]["content"] == "주문은 paid"
    types = [payload["type"] for _, payload in bus.events if isinstance(payload, dict)]
    assert types.count("tool_execution") == 2


async def test_openai_complete_posts_chat(monkeypatch):
    captured = {}

    class Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "hi", "tool_calls": None}}]}

    class FakeClient:
        async def post(self, url, **kwargs):
            captured["url"] = url
            captured["json"] = kwargs["json"]
            captured["headers"] = kwargs["headers"]
            return Resp()

    monkeypatch.setenv("AURA_LLM_API_KEY", "sk")
    monkeypatch.setenv("AURA_LLM_BASE_URL", "http://llm.test/v1")
    out = await openai_complete([{"role": "user", "content": "x"}], TOOLS, client=FakeClient())
    assert captured["url"] == "http://llm.test/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk"
    assert captured["json"]["tools"] == TOOLS
    assert out["content"] == "hi"


def test_builtin_skills_include_refund_policy():
    skills = load_builtin_skills()
    assert "refund-policy" in skills
    assert "승인" in skills["refund-policy"].body


def test_tenant_skill_overrides_builtin():
    skills = merge_skills(
        load_builtin_skills(),
        [{"name": "refund-policy", "description": "tenant", "body": "TENANT_BODY", "enabled": True}],
    )
    assert skills["refund-policy"].body == "TENANT_BODY"
    assert skills["refund-policy"].description == "tenant"


def test_from_env_stub_without_key(monkeypatch):
    monkeypatch.delenv("AURA_LLM_API_KEY", raising=False)
    assert LLM.from_env().complete is stub_complete


async def test_bind_agent_sets_tenant_guc():
    class FakeConn:
        def __init__(self):
            self.calls = []

        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def execute(self, sql, args=None):
            self.calls.append((sql, args))
            return self

        async def fetchall(self):
            return []

        async def fetchone(self):
            return None

    class FakePool:
        def __init__(self, conn):
            self._conn = conn

        def connection(self):
            return _ConnCM(self._conn)

    class _ConnCM:
        def __init__(self, conn):
            self._conn = conn

        async def __aenter__(self):
            return self._conn

        async def __aexit__(self, *_):
            return False

    conn = FakeConn()
    agent = Agent(MemoryBus())
    bind_agent(agent, FakePool(conn))
    await agent.read_ego("acc-1", "contact-1")
    assert conn.calls[0][0].startswith("SELECT set_config")
    assert conn.calls[0][1] == ("acc-1",)
    assert callable(agent.read_staff_available)


MCP_ROW = {"name": "ops", "url": "http://127.0.0.1:18082/mcp", "enabled": True}


async def test_ops_tools_reload_when_mcp_servers_appear(monkeypatch):
    loads: list = []

    async def fake_load(server=None, config=None):
        loads.append(config)
        return []

    monkeypatch.setattr("aura_ai.agent.load_ops_tools", fake_load)
    agent = Agent(MemoryBus())
    await agent.handle_reason(task())

    async def servers(*_):
        return [MCP_ROW]

    agent.read_mcp_servers = servers
    await agent.handle_reason(task())
    assert loads[0] is None
    assert loads[1]["mcpServers"]["ops"]["url"] == MCP_ROW["url"]


async def test_ops_tools_retry_after_connect_fail(monkeypatch):
    loads: list = []

    async def fake_load(server=None, config=None):
        loads.append(config)
        if config is not None and sum(1 for c in loads if c is not None) == 1:
            raise RuntimeError("Client failed to connect")
        return []

    monkeypatch.setattr("aura_ai.agent.load_ops_tools", fake_load)
    agent = Agent(MemoryBus())

    async def servers(*_):
        return [MCP_ROW]

    agent.read_mcp_servers = servers
    await agent.handle_reason(task())
    await agent.handle_reason(task())
    remote = [c for c in loads if c is not None]
    assert len(remote) == 2
    assert any(c is None for c in loads)


async def test_load_ops_tools_fails_fast_when_mcp_down():
    import time

    from aura_ai.mcp_ops import load_ops_tools

    t0 = time.monotonic()
    with pytest.raises(Exception):
        await load_ops_tools(config={"mcpServers": {"ops": {"url": "http://127.0.0.1:1/mcp"}}})
    assert time.monotonic() - t0 < 2
