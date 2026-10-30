import uuid

from aura_ai.agent import Agent, MemoryBus, new_id
from aura_ai.ego import bind_agent
from aura_ai.limit import ChannelGuard, CircuitOpen
from aura_ai.llm import LLM, openai_complete, stub_complete
from aura_ai.tools import TOOLS


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


def test_reason_increments_hop_and_sets_causation():
    bus = MemoryBus()
    agent = Agent(bus)
    env = agent.handle_reason(task(hop_count=0, trigger_message_id="m1", trace_id="abc"))
    assert env["hop_count"] == 1
    assert env["causation_id"] == "m1"
    assert env["trace_id"] == "abc"


def test_reason_drops_when_hop_exceeds_five():
    bus = MemoryBus()
    agent = Agent(bus)
    env = agent.handle_reason(task(hop_count=6))
    assert env["skipped"] is True
    assert bus.events == []


def test_low_risk_sends_outbound_message():
    bus = MemoryBus()
    agent = Agent(bus)
    env = agent.handle_reason(task())
    types = [payload["type"] for _, payload in bus.events if isinstance(payload, dict) and "type" in payload]
    assert "message_created" in types
    assert env["payload"]["content_type"] == "text"
    assert env["payload"]["sender_type"] == "AgentBot"


def test_high_risk_emits_approval_card():
    bus = MemoryBus()
    agent = Agent(bus)
    env = agent.handle_reason(task(content="환불 해주세요"))
    assert env["payload"]["content_type"] == "form"
    card = __import__("json").loads(env["payload"]["content"])
    assert card["kind"] == "tool_approval"
    assert card["tool_name"] == "refund"
    assert any(payload.get("type") == "tool_execution" for _, payload in bus.events)


def test_extract_writes_ontology_event():
    bus = MemoryBus()
    agent = Agent(bus)
    agent.read_messages = lambda *_: "결제 오류로 문의"
    env = agent.handle_extract(task())
    assert env["type"] == "ontology_extracted"
    assert any(n["entity_type"] == "PainPoint" for n in env["payload"]["nodes"])


def test_embed_has_1536_dims():
    bus = MemoryBus()
    agent = Agent(bus)
    env = agent.handle_embed({"account_id": "a", "owner_type": "article", "owner_id": "art"})
    assert len(env["payload"]["embedding"]) == 1536


def test_guard_opens_circuit():
    g = ChannelGuard(rps=100, burst=100, failures_needed=2, open_for=30)
    g.failure("email")
    g.failure("email")
    try:
        g.allow("email")
        raised = False
    except CircuitOpen:
        raised = True
    assert raised


def test_new_id_is_uuid7():
    assert uuid.UUID(new_id()).version == 7


def test_reason_passes_ego_and_lookup_result():
    seen = []

    def complete(messages, _tools):
        seen.append(messages)
        if len(seen) == 1:
            return {"tool_calls": [{"id": "1", "function": {"name": "lookup_order", "arguments": {"order_id": "9"}}}]}
        return {"tool_calls": [{"function": {"name": "send_status", "arguments": {"content": "주문은 paid"}}}]}

    bus = MemoryBus()
    agent = Agent(bus, LLM(complete))
    agent.read_ego = lambda *_: [{"name": "결제 오류", "entity_type": "PainPoint"}]
    env = agent.handle_reason(task())
    assert "결제 오류" in seen[0][1]["content"]
    assert "paid" in seen[1][-1]["content"]
    assert env["payload"]["content"] == "주문은 paid"
    types = [payload["type"] for _, payload in bus.events if isinstance(payload, dict)]
    assert types.count("tool_execution") == 2


def test_openai_complete_posts_chat(monkeypatch):
    captured = {}

    class Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "hi", "tool_calls": None}}]}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs["json"]
        captured["headers"] = kwargs["headers"]
        return Resp()

    monkeypatch.setenv("AURA_LLM_API_KEY", "sk")
    monkeypatch.setenv("AURA_LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setattr("httpx.post", fake_post)
    out = openai_complete([{"role": "user", "content": "x"}], TOOLS)
    assert captured["url"] == "http://llm.test/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk"
    assert captured["json"]["tools"] == TOOLS
    assert out["content"] == "hi"


def test_from_env_stub_without_key(monkeypatch):
    monkeypatch.delenv("AURA_LLM_API_KEY", raising=False)
    assert LLM.from_env().complete is stub_complete


def test_bind_agent_sets_tenant_guc():
    class FakeConn:
        def __init__(self):
            self.calls = []

        def transaction(self):
            return self

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def execute(self, sql, args=None):
            self.calls.append((sql, args))
            return self

        def fetchall(self):
            return []

        def fetchone(self):
            return None

    conn = FakeConn()
    agent = Agent(MemoryBus())
    bind_agent(agent, conn)
    agent.read_ego("acc-1", "contact-1")
    assert conn.calls[0][0].startswith("SELECT set_config")
    assert conn.calls[0][1] == ("acc-1",)
