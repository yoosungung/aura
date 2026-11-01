from virtual_client.adapters.email import EmailAdapter


def test_email_adapter_sends_mime_and_reads_mailpit():
    sent: list = []
    inbox = [{"ID": "old", "To": [{"Address": "virtual.customer@test.invalid"}]}]
    details = {
        "new": {"Text": "반품 접수가 완료되었습니다."},
        "new2": {"Text": "반품 접수가 완료되었습니다."},
    }

    def smtp_send(msg) -> None:
        sent.append(msg)
        mid = "new" if len(sent) == 1 else "new2"
        inbox.append({"ID": mid, "To": [{"Address": "virtual.customer@test.invalid"}]})

    def http_get(url: str, timeout: float = 10.0):
        class Res:
            def raise_for_status(self) -> None:
                return None

            def json(self):
                if "/message/" in url:
                    mid = url.rsplit("/", 1)[-1]
                    return details[mid]
                return {"messages": inbox}

        return Res()

    adapter = EmailAdapter(
        smtp_host="127.0.0.1",
        smtp_port=2050,
        helpdesk="help@local.test",
        customer="virtual.customer@test.invalid",
        timeout=2.0,
        poll=0.01,
        smtp_send=smtp_send,
        http_get=http_get,
    )
    adapter.seen_ids = {"old"}
    got = adapter.send("환불해주세요")
    assert got == "반품 접수가 완료되었습니다."
    assert sent[0]["From"] == "virtual.customer@test.invalid"
    assert sent[0]["To"] == "help@local.test"
    assert "Message-ID" in sent[0]
    second = adapter.send("감사합니다")
    assert sent[1]["In-Reply-To"] == sent[0]["Message-ID"]
    assert second == "반품 접수가 완료되었습니다."
