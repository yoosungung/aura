from virtual_client.run import wrap_adapter


def test_wrap_adapter_sends_user_text():
    class Fake:
        def send(self, text: str) -> str:
            return f"echo:{text}"

    assert wrap_adapter(Fake()).reply("취소") == "echo:취소"
