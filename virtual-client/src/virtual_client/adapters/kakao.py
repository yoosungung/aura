from __future__ import annotations

import uuid
from typing import Callable

import httpx

from virtual_client.adapters.base import wait_until
from virtual_client.hub import KakaoHub


class KakaoAdapter:
    def __init__(
        self,
        base: str,
        sender_key: str,
        user_key: str = "virtual-customer-001",
        timeout: float = 15.0,
        poll: float = 0.4,
        on_tick: Callable[[], None] | None = None,
    ) -> None:
        self.base = base.rstrip("/")
        self.sender_key = sender_key
        self.user_key = user_key
        self.timeout = timeout
        self.poll = poll
        self.on_tick = on_tick
        self._after_send: Callable[[], None] | None = None

    def send(self, user_message: str) -> str:
        seen = len(KakaoHub.inbox)
        payload = {
            "msgKey": str(uuid.uuid4()),
            "userKey": self.user_key,
            "senderKey": self.sender_key,
            "serviceType": "CSTALK",
            "msgType": "TEXT",
            "requestType": "message",
            "contents": [{"comment": user_message}],
        }
        ack = httpx.post(f"{self.base}/cstalk/message", json=payload, timeout=10.0)
        ack.raise_for_status()
        if ack.json().get("code") != "A000":
            raise RuntimeError(ack.text)
        if self._after_send:
            self._after_send()

        def probe() -> str | None:
            for row in KakaoHub.inbox[seen:]:
                if row.get("userKey") == self.user_key:
                    text = (row.get("message") or "").strip()
                    if text:
                        return text
            return None

        return wait_until(self.timeout, self.poll, self.on_tick, probe)
