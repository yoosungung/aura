from __future__ import annotations

import asyncio
import json
import os

import httpx

from aura_ai.agent import Agent, Bus, MemoryBus, current_bus
from aura_ai.ego import bind_agent
from aura_ai.llm import LLM, embed_from_env

TASKS_STREAM = "TASKS_STREAM"


class NATSBus(Bus):
    def __init__(self, js) -> None:
        self.js = js
        self.pending: list[tuple[str, bytes]] = []

    def publish(self, subject: str, payload: dict) -> None:
        self.pending.append((subject, json.dumps(payload).encode()))

    async def flush(self) -> None:
        for subject, data in self.pending:
            await self.js.publish(subject, data)
        self.pending.clear()


async def handle_msg(msg, fn, js, sem: asyncio.Semaphore) -> None:
    buf = NATSBus(js)
    token = current_bus.set(buf)
    try:
        task = json.loads(msg.data)
        async with sem:
            await fn(task)
        await buf.flush()
        await msg.ack()
    except Exception:
        buf.pending.clear()
        await msg.nak()
    finally:
        current_bus.reset(token)


async def drain_pending(sub, limit: int = 500) -> int:
    n = 0
    while n < limit:
        try:
            msgs = await sub.fetch(min(50, limit - n), timeout=0.5)
        except Exception:
            break
        if not msgs:
            break
        for msg in msgs:
            await msg.ack()
            n += 1
    return n


async def bind_consumers(js, specs: list[tuple[str, str, object]]):
    bound = []
    for _subject, durable, fn in specs:
        bound.append((await _bind(js, durable), fn))
    return bound


async def _bind(js, durable: str):
    last = None
    for _ in range(5):
        try:
            await js.consumer_info(TASKS_STREAM, durable)
            return await js.pull_subscribe_bind(durable=durable, stream=TASKS_STREAM)
        except Exception as exc:
            last = exc
            await asyncio.sleep(1)
    raise last


async def run() -> None:
    import nats
    from psycopg_pool import AsyncConnectionPool

    nats_url = os.environ.get("AURA_NATS_URL", "nats://127.0.0.1:30422")
    client = httpx.AsyncClient(timeout=60.0)
    pool: AsyncConnectionPool | None = None
    nc = None
    try:
        nc = await nats.connect(nats_url)
        js = nc.jetstream(timeout=15)
        llm = LLM.from_env(client=client)
        agent = Agent(MemoryBus(), llm, embed=embed_from_env(client=client))
        dsn = os.environ.get("AURA_DSN")
        if dsn:
            pool = AsyncConnectionPool(conninfo=dsn, open=False, min_size=1, max_size=4)
            await pool.open()
            bind_agent(agent, pool)

        sem = asyncio.Semaphore(int(os.environ.get("AURA_AI_CONCURRENCY", "4")))
        specs = [
            ("helpdesk.tasks.ai.reasoning", "svc-ai-reasoning", agent.handle_reason),
            ("helpdesk.tasks.ai.execute", "svc-ai-execute", agent.handle_execute),
            ("helpdesk.tasks.ontology.extract", "svc-ai-ontology", agent.handle_extract),
            ("helpdesk.tasks.ai.embed", "svc-ai-embed", agent.handle_embed),
        ]
        bound = await bind_consumers(js, specs)
        if os.environ.get("AURA_JS_DRAIN_DEBUGING"):
            for sub, _fn in bound:
                await drain_pending(sub)
        for sub, fn in bound:
            asyncio.create_task(_loop(sub, fn, js, sem))
        await asyncio.Event().wait()
    finally:
        await client.aclose()
        if pool is not None:
            await pool.close()
        if nc is not None:
            await nc.drain()


async def _loop(sub, fn, js, sem: asyncio.Semaphore):
    while True:
        try:
            msgs = await sub.fetch(1, timeout=5)
        except Exception:
            continue
        for msg in msgs:
            await handle_msg(msg, fn, js, sem)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
