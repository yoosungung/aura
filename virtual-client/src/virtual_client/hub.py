from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


class KakaoHub(BaseHTTPRequestHandler):
    inbox: list = []

    def log_message(self, *_args) -> None:
        return

    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path.rstrip("/") == "/cstalk/plain":
            KakaoHub.inbox.append(body)
        self.send_response(200)
        self.end_headers()

    @classmethod
    def wait_plain(cls, user_key: str, after: int, timeout: float = 15.0, poll: float = 0.4) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for row in cls.inbox[after:]:
                if row.get("userKey") == user_key:
                    return (row.get("message") or "").strip()
            time.sleep(poll)
        return "에이전트로부터 시간 내에 카카오 회신이 도착하지 않았습니다."


def start_kakao_hub(host: str = "127.0.0.1", port: int = 18081) -> HTTPServer:
    httpd = HTTPServer((host, port), KakaoHub)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
