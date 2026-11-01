from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Callable

import httpx

WEB_PUBSUB = "virtual-web-pubsub"
KAKAO_SENDER = "virtual-kakao-sender"
HELPDESK_EMAIL = "help@virtual.test"
CUSTOMER_EMAIL = "virtual.customer@test.invalid"


@dataclass
class Context:
    access_token: str
    account_id: str
    user_id: str
    web_inbox_id: str
    kakao_inbox_id: str
    email_inbox_id: str
    kakao_sender_key: str
    helpdesk_email: str
    web_pubsub_token: str


class Bootstrap:
    def __init__(
        self,
        base: str = "http://127.0.0.1:30080",
        email: str = "admin@example.com",
        password: str = "admin1234",
        dsn: str | None = None,
        seed_web: Callable[[str, str, str], str] | None = None,
    ) -> None:
        self.base = base.rstrip("/")
        self.email = email
        self.password = password
        self.dsn = dsn or os.environ.get("AURA_DSN", "postgres://aura:aura@127.0.0.1:5432/aura?sslmode=disable")
        self.seed_web = seed_web or self._seed_web

    def run(self, mcp_url: str = "http://127.0.0.1:18082/mcp") -> Context:
        token, account_id, user_id = self._sign_in()
        headers = {"Authorization": f"Bearer {token}"}
        inboxes = self._list_inboxes(account_id, headers)
        web = _first(inboxes, "web")
        if not web:
            raise RuntimeError("web inbox missing")
        kakao = _first(inboxes, "kakao") or self._create_inbox(
            account_id, headers, "Kakao Virtual", "kakao", kakao_sender_key=KAKAO_SENDER
        )
        email_box = _first(inboxes, "email") or self._create_inbox(
            account_id, headers, "Email Virtual", "email", email_address=HELPDESK_EMAIL
        )
        pubsub = self.seed_web(account_id, web["id"], WEB_PUBSUB)
        self._register_mcp(account_id, headers, mcp_url)
        return Context(
            access_token=token,
            account_id=account_id,
            user_id=user_id,
            web_inbox_id=web["id"],
            kakao_inbox_id=kakao["id"],
            email_inbox_id=email_box["id"],
            kakao_sender_key=kakao.get("kakao_sender_key") or KAKAO_SENDER,
            helpdesk_email=email_box.get("email_address") or HELPDESK_EMAIL,
            web_pubsub_token=pubsub,
        )

    def _sign_in(self) -> tuple[str, str, str]:
        res = httpx.post(
            f"{self.base}/auth/sign_in",
            json={"email": self.email, "password": self.password},
            timeout=10.0,
        )
        res.raise_for_status()
        body = res.json()
        user = body.get("user") or {}
        return body["access_token"], user["account_id"], user.get("id") or ""

    def _list_inboxes(self, account_id: str, headers: dict) -> list[dict]:
        res = httpx.get(f"{self.base}/api/v1/accounts/{account_id}/inboxes", headers=headers, timeout=10.0)
        res.raise_for_status()
        return list(res.json().get("inboxes") or [])

    def _create_inbox(
        self,
        account_id: str,
        headers: dict,
        name: str,
        channel_type: str,
        email_address: str = "",
        kakao_sender_key: str = "",
    ) -> dict:
        payload = {"name": name, "channel_type": channel_type}
        if email_address:
            payload["email_address"] = email_address
        if kakao_sender_key:
            payload["kakao_sender_key"] = kakao_sender_key
        res = httpx.post(
            f"{self.base}/api/v1/accounts/{account_id}/inboxes",
            headers=headers,
            json=payload,
            timeout=10.0,
        )
        res.raise_for_status()
        return res.json()

    def _register_mcp(self, account_id: str, headers: dict, url: str) -> None:
        res = httpx.post(
            f"{self.base}/api/v1/accounts/{account_id}/mcp_servers",
            headers=headers,
            json={
                "name": "virtual-ops",
                "url": url,
                "enabled": True,
                "allowed_tools": ["lookup_order", "lookup_shipping", "refund"],
                "high_risk_tools": ["refund"],
            },
            timeout=10.0,
        )
        res.raise_for_status()

    def _seed_web(self, account_id: str, inbox_id: str, token: str) -> str:
        import psycopg

        contact_id = str(uuid.uuid4())
        ci_id = str(uuid.uuid4())
        with psycopg.connect(self.dsn) as conn:
            conn.execute("SELECT set_config('app.current_account_id', %s, true)", (account_id,))
            row = conn.execute(
                """
                INSERT INTO contacts (id, account_id, name, email)
                VALUES (%s, %s, 'Virtual Customer', %s)
                ON CONFLICT (account_id, email) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                (contact_id, account_id, CUSTOMER_EMAIL),
            ).fetchone()
            cid = row[0]
            conn.execute(
                """
                INSERT INTO contact_inboxes (id, account_id, contact_id, inbox_id, source_id, pubsub_token)
                VALUES (%s, %s, %s, %s, 'widget-virtual-001', %s)
                ON CONFLICT (inbox_id, source_id) DO UPDATE SET pubsub_token = EXCLUDED.pubsub_token
                """,
                (ci_id, account_id, cid, inbox_id, token),
            )
            conn.commit()
        return token


def _first(rows: list[dict], channel: str) -> dict | None:
    for row in rows:
        if row.get("channel_type") == channel:
            return row
    return None
