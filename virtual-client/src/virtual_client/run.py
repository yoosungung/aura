from __future__ import annotations

import asyncio
import os
from typing import Any, Callable

from virtual_client.adapters.email import EmailAdapter
from virtual_client.adapters.kakao import KakaoAdapter
from virtual_client.adapters.web import WebAdapter
from virtual_client.bootstrap import CUSTOMER_EMAIL, Context
from virtual_client.cli import CHANNELS, parse_args
from virtual_client.counselor import Counselor
from virtual_client.mcp_mock import set_scenario, start_mcp
from virtual_client.scenarios import SCENARIOS, ScenarioSpec, get_scenario
from virtual_client.hub import start_kakao_hub


class ChannelAgent:
    def __init__(self, adapter: Any, name: str = "aura") -> None:
        self.adapter = adapter
        self.name = name

    def reply(self, user_message: str) -> str:
        return self.adapter.send(user_message)


def wrap_adapter(adapter: Any, name: str = "aura") -> ChannelAgent:
    return ChannelAgent(adapter, name)


def _configure_llm() -> str:
    key = os.environ.get("AURA_LLM_API_KEY") or ""
    if key and not os.environ.get("OPENAI_API_KEY"):
        os.environ["OPENAI_API_KEY"] = key
    model = os.environ.get("AURA_LLM_MODEL") or "gpt-4o-mini"
    if "/" not in model:
        model = f"openai/{model}"
    return model


async def run_one(channel: str, spec: ScenarioSpec, adapter: Any, max_turns: int) -> Any:
    os.environ.setdefault("SCENARIO_CACHE_DIR", "/tmp/aura-scenario-cache")
    import scenario

    model = _configure_llm()
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("AURA_LLM_API_KEY")
    api_base = os.environ.get("AURA_LLM_BASE_URL") or None
    scenario.configure(default_model=model)
    agent = wrap_adapter(adapter, f"aura-{channel}")

    class Adapter(scenario.AgentAdapter):
        name = agent.name

        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return agent.reply(input.last_new_user_message_str())

    kwargs: dict[str, Any] = {
        "name": f"[{channel}] {spec.title}",
        "description": f"persona: {spec.persona}\ngoal: {spec.goal}",
        "agents": [
            Adapter(),
            scenario.UserSimulatorAgent(persona=spec.persona, model=model, api_key=api_key, api_base=api_base),
            scenario.JudgeAgent(criteria=list(spec.criteria), model=model, api_key=api_key, api_base=api_base),
        ],
        "max_turns": max_turns,
    }
    return await scenario.run(**kwargs)


def build_adapter(channel: str, ctx: Context, args: Any, on_tick: Callable[[], None] | None) -> Any:
    if channel == "web":
        return WebAdapter(args.base, ctx.web_inbox_id, ctx.web_pubsub_token, on_tick=on_tick)
    if channel == "kakao":
        return KakaoAdapter(args.kakao_base, ctx.kakao_sender_key, on_tick=on_tick)
    if channel == "email":
        return EmailAdapter(
            smtp_host=args.smtp_host,
            smtp_port=args.smtp_port,
            helpdesk=ctx.helpdesk_email,
            customer=CUSTOMER_EMAIL,
            on_tick=on_tick,
        )
    raise ValueError(channel)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    channels = list(CHANNELS) if args.channel == "all" else [args.channel]
    names = list(SCENARIOS) if args.scenario == "all" else [args.scenario]

    start_kakao_hub()
    first = set_scenario(names[0])
    mcp = start_mcp(first)
    print(f"mock MCP {mcp} — svc-ai-agent를 재시작하세요 (도구 캐시).")

    from virtual_client.bootstrap import Bootstrap

    if args.skip_bootstrap:
        raise SystemExit("bootstrap 없이는 인박스·시드가 없습니다")
    ctx = Bootstrap(base=args.base).run(mcp_url=mcp)
    counselor = Counselor(args.base, ctx.account_id, ctx.access_token)

    failed = 0
    for spec_name in names:
        store = set_scenario(spec_name)
        spec = get_scenario(spec_name)
        print(f"== fixture {store.name} ==")
        for channel in channels:
            adapter = build_adapter(channel, ctx, args, on_tick=counselor.approve_pending)
            print(f"-- {channel} {spec.name} --")
            result = asyncio.run(run_one(channel, spec, adapter, args.max_turns))
            ok = bool(getattr(result, "success", False))
            reason = getattr(result, "reasoning", "") or ""
            failed_criteria = getattr(result, "failed_criteria", None) or []
            if failed_criteria:
                reason = reason or ", ".join(failed_criteria)
            if ok:
                print("PASS")
            else:
                failed += 1
                print(f"FAIL {reason}")
    return 1 if failed else 0
