from __future__ import annotations

import json

import httpx


class Counselor:
    def __init__(self, base: str, account_id: str, access_token: str) -> None:
        self.base = base.rstrip("/")
        self.account_id = account_id
        self.headers = {"Authorization": f"Bearer {access_token}"}
        self.seen: set[str] = set()

    def approve_pending(self) -> int:
        listing = httpx.get(
            f"{self.base}/api/v1/accounts/{self.account_id}/conversations",
            headers=self.headers,
            timeout=10.0,
        )
        listing.raise_for_status()
        n = 0
        for conv in listing.json().get("conversations") or []:
            cid = conv.get("id") or ""
            if not cid:
                continue
            n += self._approve_conversation(cid)
        return n

    def _approve_conversation(self, conversation_id: str) -> int:
        got = httpx.get(
            f"{self.base}/api/v1/accounts/{self.account_id}/conversations/{conversation_id}/messages",
            headers=self.headers,
            timeout=10.0,
        )
        got.raise_for_status()
        n = 0
        for row in got.json().get("messages") or []:
            if row.get("content_type") != "form":
                continue
            exec_id = _execution_id(row.get("content") or "")
            if not exec_id or exec_id in self.seen:
                continue
            res = httpx.post(
                f"{self.base}/api/v1/accounts/{self.account_id}/conversations/{conversation_id}/tools/{exec_id}/approve",
                headers=self.headers,
                timeout=10.0,
            )
            res.raise_for_status()
            self.seen.add(exec_id)
            n += 1
        return n


def _execution_id(content: str) -> str:
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return ""
    if isinstance(data, dict) and data.get("kind") == "tool_approval":
        return str(data.get("execution_id") or "")
    return ""
