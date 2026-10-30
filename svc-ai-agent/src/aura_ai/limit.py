from __future__ import annotations

import time
from dataclasses import dataclass, field


class RateLimited(Exception):
    pass


class CircuitOpen(Exception):
    pass


@dataclass
class ChannelGuard:
    rps: float = 20
    burst: float = 40
    failures_needed: int = 5
    open_for: float = 30
    tokens: dict[str, float] = field(default_factory=dict)
    last: dict[str, float] = field(default_factory=dict)
    failures: dict[str, int] = field(default_factory=dict)
    opened_at: dict[str, float] = field(default_factory=dict)

    def allow(self, channel: str) -> None:
        now = time.monotonic()
        fails = self.failures.get(channel, 0)
        if fails >= self.failures_needed:
            if now - self.opened_at.get(channel, 0) < self.open_for:
                raise CircuitOpen(channel)
            self.failures[channel] = 0
        last = self.last.get(channel, now)
        tokens = self.tokens.get(channel, self.burst)
        tokens = min(self.burst, tokens + (now - last) * self.rps)
        if tokens < 1:
            raise RateLimited(channel)
        self.tokens[channel] = tokens - 1
        self.last[channel] = now

    def success(self, channel: str) -> None:
        self.failures[channel] = 0

    def failure(self, channel: str) -> None:
        n = self.failures.get(channel, 0) + 1
        self.failures[channel] = n
        if n >= self.failures_needed:
            self.opened_at[channel] = time.monotonic()
