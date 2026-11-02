from __future__ import annotations

import smtplib
import uuid
from email.mime.text import MIMEText
from typing import Callable

import httpx

from virtual_client.adapters.base import resolve_reply_timeout, wait_until


class EmailAdapter:
    def __init__(
        self,
        smtp_host: str = "127.0.0.1",
        smtp_port: int = 2050,
        helpdesk: str = "help@virtual.test",
        customer: str = "virtual.customer@test.invalid",
        mailpit: str = "http://127.0.0.1:8025/api/v1",
        timeout: float | None = None,
        poll: float = 0.4,
        on_tick: Callable[[], None] | None = None,
        smtp_send: Callable | None = None,
        http_get: Callable | None = None,
    ) -> None:
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.helpdesk = helpdesk
        self.customer = customer
        self.mailpit = mailpit.rstrip("/")
        self.timeout = resolve_reply_timeout(timeout)
        self.poll = poll
        self.on_tick = on_tick
        self.smtp_send = smtp_send or self._smtp_send
        self.http_get = http_get or (lambda url, timeout=10.0: httpx.get(url, timeout=timeout))
        self.last_message_id = ""
        self.seen_ids: set[str] = set()

    def _smtp_send(self, msg: MIMEText) -> None:
        with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
            server.send_message(msg)

    def send(self, user_message: str) -> str:
        msg_id = f"<{uuid.uuid4()}@virtual.test>"
        msg = MIMEText(user_message, "plain", "utf-8")
        msg["Subject"] = "문의"
        msg["From"] = self.customer
        msg["To"] = self.helpdesk
        msg["Message-ID"] = msg_id
        if self.last_message_id:
            msg["In-Reply-To"] = self.last_message_id
            msg["References"] = self.last_message_id
        self.smtp_send(msg)
        self.last_message_id = msg_id

        def probe() -> str | None:
            listing = self.http_get(f"{self.mailpit}/messages", timeout=10.0)
            listing.raise_for_status()
            for m in listing.json().get("messages") or []:
                mid = m.get("ID", "")
                if mid in self.seen_ids:
                    continue
                tos = [t.get("Address", "") for t in m.get("To", [])]
                if self.customer not in tos:
                    continue
                detail = self.http_get(f"{self.mailpit}/message/{mid}", timeout=10.0)
                detail.raise_for_status()
                text = (detail.json().get("Text") or "").strip()
                if not text:
                    continue
                self.seen_ids.add(mid)
                return text
            return None

        return wait_until(self.timeout, self.poll, self.on_tick, probe)
