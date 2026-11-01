import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from virtual_client.counselor import Counselor


class FakeDesk(BaseHTTPRequestHandler):
    approved: list = []
    messages = [
        {"id": "m1", "content": "안녕하세요", "sender_type": "Contact", "content_type": "text"},
        {
            "id": "m2",
            "content": json.dumps({"kind": "tool_approval", "execution_id": "exec-9", "tool_name": "refund"}),
            "sender_type": "AgentBot",
            "content_type": "form",
        },
    ]

    def log_message(self, *_args) -> None:
        return

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if self.path.endswith("/conversations"):
            self.wfile.write(json.dumps({"conversations": [{"id": "conv-1"}]}).encode())
            return
        self.wfile.write(json.dumps({"messages": self.messages}).encode())

    def do_POST(self) -> None:
        FakeDesk.approved.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


def test_counselor_approves_form_cards_only():
    FakeDesk.approved = []
    httpd = HTTPServer(("127.0.0.1", 0), FakeDesk)
    Thread(target=httpd.serve_forever, daemon=True).start()
    c = Counselor(
        base=f"http://127.0.0.1:{httpd.server_address[1]}",
        account_id="acc-1",
        access_token="admin-tok",
    )
    n = c.approve_pending()
    assert n == 1
    assert FakeDesk.approved[0].endswith("/conversations/conv-1/tools/exec-9/approve")
    n2 = c.approve_pending()
    assert n2 == 0
    httpd.shutdown()
