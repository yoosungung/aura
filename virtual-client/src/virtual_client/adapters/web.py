from __future__ import annotations

from typing import Callable

import httpx

from virtual_client.adapters.base import is_customer_reply, wait_until


class WebAdapter:
    def __init__(
        self,
        base: str,
        inbox_id: str,
        pubsub_token: str,
        timeout: float = 15.0,
        poll: float = 0.4,
        on_tick: Callable[[], None] | None = None,
    ) -> None:
        self.base = base.rstrip("/")
        self.inbox_id = inbox_id
        self.pubsub_token = pubsub_token
        self.timeout = timeout
        self.poll = poll
        self.on_tick = on_tick
        self.token = ""
        self.contact_id = ""
        self.conversation_id = ""

    def send(self, user_message: str) -> str:
        if not self.token:
            auth = httpx.post(
                f"{self.base}/public/api/v1/inboxes/{self.inbox_id}/auth",
                json={"pubsub_token": self.pubsub_token},
                timeout=10.0,
            )
            auth.raise_for_status()
            self.token = auth.json()["access_token"]

        headers = {"Authorization": f"Bearer {self.token}"}
        path = f"{self.base}/public/api/v1/inboxes/{self.inbox_id}/messages"
        if self.contact_id and self.conversation_id:
            path = (
                f"{self.base}/public/api/v1/inboxes/{self.inbox_id}"
                f"/contacts/{self.contact_id}/conversations/{self.conversation_id}/messages"
            )
        posted = httpx.post(path, headers=headers, json={"content": user_message}, timeout=10.0)
        posted.raise_for_status()
        out = posted.json()
        self.contact_id = out.get("contact_id") or self.contact_id
        self.conversation_id = out.get("conversation_id") or self.conversation_id
        if out.get("token"):
            self.token = out["token"]

        seen = {user_message.strip()}

        def probe() -> str | None:
            got = httpx.get(
                f"{self.base}/public/api/v1/inboxes/{self.inbox_id}"
                f"/contacts/{self.contact_id}/conversations/{self.conversation_id}/messages",
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=10.0,
            )
            got.raise_for_status()
            for row in reversed(got.json().get("messages") or []):
                if not is_customer_reply(row):
                    continue
                text = (row.get("content") or "").strip()
                if text in seen:
                    continue
                return text
            return None

        return wait_until(self.timeout, self.poll, self.on_tick, probe)
