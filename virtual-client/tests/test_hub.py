import json
from http.client import HTTPConnection

from virtual_client.hub import KakaoHub, start_kakao_hub


def test_hub_captures_plain_by_user_key():
    httpd = start_kakao_hub("127.0.0.1", 0)
    port = httpd.server_address[1]
    seen = len(KakaoHub.inbox)
    conn = HTTPConnection("127.0.0.1", port)
    body = json.dumps({"userKey": "virtual-customer-001", "message": "배송 출발했습니다"})
    conn.request("POST", "/cstalk/plain", body=body, headers={"Content-Type": "application/json"})
    res = conn.getresponse()
    assert res.status == 200
    assert KakaoHub.wait_plain("virtual-customer-001", seen, timeout=1.0) == "배송 출발했습니다"
    httpd.shutdown()
