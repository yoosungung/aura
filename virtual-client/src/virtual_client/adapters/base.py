from __future__ import annotations

import json
import os
import time
from typing import Callable


TIMEOUT_REPLY = "에이전트로부터 시간 내에 회신이 도착하지 않았습니다."
DEFAULT_REPLY_TIMEOUT = 15.0


def resolve_reply_timeout(timeout: float | None = None) -> float:
    if timeout is not None:
        return timeout
    raw = os.environ.get("AURA_VC_REPLY_TIMEOUT", "").strip()
    if not raw:
        return DEFAULT_REPLY_TIMEOUT
    return float(raw)


def is_customer_reply(row: dict) -> bool:
    if row.get("sender_type") not in ("AgentBot", "User"):
        return False
    content = (row.get("content") or "").strip()
    if not content:
        return False
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return True
    if isinstance(data, dict) and data.get("kind") == "tool_approval":
        return False
    return True


def wait_until(timeout: float, poll: float, tick: Callable[[], None] | None, probe: Callable[[], str | None]) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if tick:
            tick()
        got = probe()
        if got:
            return got
        time.sleep(poll)
    return TIMEOUT_REPLY
