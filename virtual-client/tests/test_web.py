import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from virtual_client.adapters.base import is_customer_reply, resolve_reply_timeout
from virtual_client.adapters.email import EmailAdapter
from virtual_client.adapters.kakao import KakaoAdapter
from virtual_client.adapters.web import WebAdapter


def test_skips_approval_card_json():
    assert not is_customer_reply(
        {"sender_type": "AgentBot", "content": json.dumps({"kind": "tool_approval", "execution_id": "e1"})}
    )
    assert is_customer_reply({"sender_type": "AgentBot", "content": "반품으로 안내드립니다."})
    assert not is_customer_reply({"sender_type": "Contact", "content": "취소해주세요"})


class FakeWeb(BaseHTTPRequestHandler):
    posted: list = []
    replies: list = []

    def log_message(self, *_args) -> None:
        return

    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        self.posted.append((self.path, body, self.headers.get("Authorization")))
        if self.path.endswith("/auth"):
            out = {"access_token": "tok-1"}
        else:
            out = {
                "contact_id": "c1",
                "conversation_id": "v1",
                "token": "tok-2",
                "message_id": "m1",
                "contact_inbox_id": "ci1",
            }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(out).encode())

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"messages": list(self.replies)}).encode())


def test_web_adapter_auth_post_and_polls_agentbot():
    FakeWeb.posted = []
    FakeWeb.replies = [
        {"sender_type": "Contact", "content": "취소하고 싶어요"},
        {"sender_type": "AgentBot", "content": json.dumps({"kind": "tool_approval", "execution_id": "e"})},
        {"sender_type": "AgentBot", "content": "배송이 시작되어 취소 대신 반품입니다."},
    ]
    httpd = HTTPServer(("127.0.0.1", 0), FakeWeb)
    Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    adapter = WebAdapter(
        base=f"http://127.0.0.1:{port}",
        inbox_id="inbox-1",
        pubsub_token="seed-token",
        timeout=2.0,
        poll=0.01,
    )
    got = adapter.send("취소하고 싶어요")
    assert got == "배송이 시작되어 취소 대신 반품입니다."
    assert FakeWeb.posted[0][0].endswith("/inboxes/inbox-1/auth")
    assert FakeWeb.posted[0][1] == {"pubsub_token": "seed-token"}
    assert adapter.conversation_id == "v1"
    httpd.shutdown()


def test_reply_timeout_is_15s_unless_debug_env(monkeypatch):
    monkeypatch.delenv("AURA_VC_REPLY_TIMEOUT", raising=False)
    assert resolve_reply_timeout() == 15.0
    assert resolve_reply_timeout(2.0) == 2.0
    monkeypatch.setenv("AURA_VC_REPLY_TIMEOUT", "600")
    assert resolve_reply_timeout() == 600.0
    assert WebAdapter("http://127.0.0.1", "inbox", "seed").timeout == 600.0
    assert KakaoAdapter("http://127.0.0.1", "sender").timeout == 600.0
    assert EmailAdapter().timeout == 600.0
