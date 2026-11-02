import asyncio
import json
import time

from aura_ai.__main__ import TASKS_STREAM, bind_consumers, drain_pending, handle_msg


class DummyBus:
    def __init__(self) -> None:
        self.pending: list = []
        self.flushed = 0

    async def flush(self) -> None:
        self.flushed += 1


class DummyMsg:
    def __init__(self, payload: dict | None = None) -> None:
        self.data = json.dumps(payload or {}).encode()
        self.acked = False
        self.naked = False

    async def ack(self) -> None:
        self.acked = True

    async def nak(self) -> None:
        self.naked = True


class FakeJS:
    def __init__(self) -> None:
        self.infos: list[tuple[str, str]] = []
        self.binds: list[tuple[str, str]] = []

    async def consumer_info(self, stream: str, durable: str):
        self.infos.append((stream, durable))
        return object()

    async def pull_subscribe_bind(self, durable: str, stream: str):
        self.binds.append((stream, durable))
        return f"sub-{durable}"


def test_bind_consumers_binds_all_existing_durables_before_return():
    async def go():
        js = FakeJS()
        specs = [
            ("helpdesk.tasks.ai.reasoning", "svc-ai-reasoning", lambda _t: None),
            ("helpdesk.tasks.ai.execute", "svc-ai-execute", lambda _t: None),
        ]
        bound = await bind_consumers(js, specs)
        assert js.infos == [(TASKS_STREAM, "svc-ai-reasoning"), (TASKS_STREAM, "svc-ai-execute")]
        assert js.binds == [(TASKS_STREAM, "svc-ai-reasoning"), (TASKS_STREAM, "svc-ai-execute")]
        assert [sub for sub, _ in bound] == ["sub-svc-ai-reasoning", "sub-svc-ai-execute"]

    asyncio.run(go())


def test_handle_msg_does_not_block_event_loop():
    markers: list[str] = []

    def blocking_fn(_task: dict) -> None:
        time.sleep(0.2)
        markers.append("fn")

    async def ticker() -> None:
        for _ in range(4):
            await asyncio.sleep(0.04)
            markers.append("tick")

    async def go() -> None:
        bus = DummyBus()
        work = asyncio.Lock()
        msg = DummyMsg()
        await asyncio.gather(handle_msg(msg, blocking_fn, bus, work), ticker())
        assert msg.acked
        assert "fn" in markers
        assert "tick" in markers
        assert markers.index("tick") < markers.index("fn")

    asyncio.run(go())


class FakeSub:
    def __init__(self, payloads: list[dict]) -> None:
        self.queue = list(payloads)
        self.acked: list[DummyMsg] = []

    async def fetch(self, n: int, timeout: float = 5):
        if not self.queue:
            raise TimeoutError()
        out = []
        for _ in range(min(n, len(self.queue))):
            msg = DummyMsg(self.queue.pop(0))
            self.acked.append(msg)
            out.append(msg)
        return out


def test_drain_pending_acks_backlog_without_running_handler():
    ran = []

    async def go():
        sub = FakeSub([{"content": "old-1"}, {"content": "old-2"}, {"content": "old-3"}])
        n = await drain_pending(sub)
        assert n == 3
        assert all(m.acked for m in sub.acked)
        assert ran == []

    asyncio.run(go())
