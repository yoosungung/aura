from __future__ import annotations

import asyncio
import json
import os

from aura_ai.agent import Agent, Bus
from aura_ai.ego import bind_agent
from aura_ai.llm import LLM, embed_from_env


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


async def run() -> None:
    import nats

    nats_url = os.environ.get("AURA_NATS_URL", "nats://127.0.0.1:4222")
    nc = await nats.connect(nats_url)
    js = nc.jetstream()
    bus = NATSBus(js)
    agent = Agent(bus, LLM.from_env(), embed=embed_from_env())
    dsn = os.environ.get("AURA_DSN")
    conn = None
    if dsn:
        import psycopg

        conn = psycopg.connect(dsn)
        bind_agent(agent, conn)

    async def handle(msg, fn):
        try:
            task = json.loads(msg.data)
            fn(task)
            await bus.flush()
            await msg.ack()
        except Exception:
            bus.pending.clear()
            await msg.nak()

    subs = [
        ("helpdesk.tasks.ai.reasoning", "svc-ai-reasoning", agent.handle_reason),
        ("helpdesk.tasks.ai.execute", "svc-ai-execute", agent.handle_execute),
        ("helpdesk.tasks.ontology.extract", "svc-ai-ontology", agent.handle_extract),
        ("helpdesk.tasks.ai.embed", "svc-ai-embed", agent.handle_embed),
    ]
    for subject, durable, fn in subs:
        sub = await js.pull_subscribe(subject, durable=durable)
        asyncio.create_task(_loop(sub, fn, handle))
    await asyncio.Event().wait()


async def _loop(sub, fn, handle):
    while True:
        try:
            msgs = await sub.fetch(1, timeout=5)
        except Exception:
            continue
        for msg in msgs:
            await handle(msg, fn)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
