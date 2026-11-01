import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from virtual_client.adapters.kakao import KakaoAdapter
from virtual_client.hub import KakaoHub, start_kakao_hub


class FakeKakao(BaseHTTPRequestHandler):
    last: dict = {}

    def log_message(self, *_args) -> None:
        return

    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        FakeKakao.last = json.loads(self.rfile.read(n) or b"{}")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"code":"A000","result":"Success"}')


def test_kakao_adapter_posts_cstalk_and_reads_hub():
    KakaoHub.inbox = []
    hub = start_kakao_hub("127.0.0.1", 0)
    gw = HTTPServer(("127.0.0.1", 0), FakeKakao)
    Thread(target=gw.serve_forever, daemon=True).start()
    adapter = KakaoAdapter(
        base=f"http://127.0.0.1:{gw.server_address[1]}",
        sender_key="sender-1",
        user_key="virtual-customer-001",
        timeout=2.0,
        poll=0.01,
    )
    seen = len(KakaoHub.inbox)

    def after_send() -> None:
        KakaoHub.inbox.append({"userKey": "virtual-customer-001", "message": "주문번호를 알려주세요."})

    adapter._after_send = after_send
    got = adapter.send("취소해주세요")
    assert FakeKakao.last["senderKey"] == "sender-1"
    assert FakeKakao.last["userKey"] == "virtual-customer-001"
    assert FakeKakao.last["contents"][0]["comment"] == "취소해주세요"
    assert FakeKakao.last["msgType"] == "TEXT"
    assert got == "주문번호를 알려주세요."
    assert seen == 0
    gw.shutdown()
    hub.shutdown()
