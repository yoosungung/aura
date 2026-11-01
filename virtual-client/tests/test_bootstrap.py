import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from virtual_client.bootstrap import Bootstrap


class FakeAPI(BaseHTTPRequestHandler):
    calls: list = []
    inboxes: list = [
        {"id": "web-1", "name": "Web", "channel_type": "web", "email_address": "", "kakao_sender_key": ""},
    ]

    def log_message(self, *_args) -> None:
        return

    def _read(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _json(self, payload, status=200) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        body = self._read()
        FakeAPI.calls.append(("POST", self.path, body, self.headers.get("Authorization")))
        if self.path == "/auth/sign_in":
            self._json({
                "access_token": "admin-tok",
                "user": {"id": "u1", "account_id": "acc-1", "role": "administrator", "email": body.get("email")},
            })
            return
        if self.path.endswith("/inboxes"):
            row = {
                "id": "new-" + body["channel_type"],
                "name": body["name"],
                "channel_type": body["channel_type"],
                "email_address": body.get("email_address", ""),
                "kakao_sender_key": body.get("kakao_sender_key", ""),
            }
            FakeAPI.inboxes.append(row)
            self._json(row)
            return
        if self.path.endswith("/mcp_servers"):
            self._json({"id": "mcp-1", "name": body["name"], "url": body["url"], "enabled": True})
            return
        self._json({"ok": False}, 404)

    def do_GET(self) -> None:
        FakeAPI.calls.append(("GET", self.path, {}, self.headers.get("Authorization")))
        if self.path.endswith("/inboxes"):
            self._json({"inboxes": FakeAPI.inboxes})
            return
        self._json({}, 404)


def test_bootstrap_signs_in_creates_missing_inboxes_registers_mcp(tmp_path):
    FakeAPI.calls = []
    FakeAPI.inboxes = [
        {"id": "web-1", "name": "Web", "channel_type": "web", "email_address": "", "kakao_sender_key": ""},
    ]
    httpd = HTTPServer(("127.0.0.1", 0), FakeAPI)
    Thread(target=httpd.serve_forever, daemon=True).start()
    seeded = {}

    def seed_web(account_id, inbox_id, token):
        seeded["account_id"] = account_id
        seeded["inbox_id"] = inbox_id
        seeded["token"] = token
        return token

    boot = Bootstrap(base=f"http://127.0.0.1:{httpd.server_address[1]}", seed_web=seed_web)
    ctx = boot.run(mcp_url="http://127.0.0.1:18082/mcp")
    assert ctx.access_token == "admin-tok"
    assert ctx.account_id == "acc-1"
    assert ctx.web_inbox_id == "web-1"
    assert ctx.kakao_inbox_id == "new-kakao"
    assert ctx.email_inbox_id == "new-email"
    assert ctx.kakao_sender_key
    assert ctx.helpdesk_email
    assert ctx.web_pubsub_token
    assert seeded["inbox_id"] == "web-1"
    mcp_posts = [c for c in FakeAPI.calls if c[0] == "POST" and str(c[1]).endswith("/mcp_servers")]
    assert mcp_posts[0][2]["url"] == "http://127.0.0.1:18082/mcp"
    httpd.shutdown()
