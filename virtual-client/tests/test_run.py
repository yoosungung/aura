import pytest

from virtual_client.run import configure_llm, wrap_adapter


def test_wrap_adapter_sends_user_text():
    class Fake:
        def send(self, text: str) -> str:
            return f"echo:{text}"

    assert wrap_adapter(Fake()).reply("취소") == "echo:취소"


def test_configure_llm_uses_aura_key_model_and_rewrites_docker_host():
    cfg = configure_llm(
        {
            "AURA_LLM_API_KEY": "ollama",
            "AURA_LLM_MODEL": "gemma4:e2b-mlx",
            "AURA_LLM_BASE_URL": "http://host.docker.internal:11434/v1",
        }
    )
    assert cfg.model == "openai/gemma4:e2b-mlx"
    assert cfg.api_key == "ollama"
    assert cfg.api_base == "http://127.0.0.1:11434/v1"


def test_configure_llm_requires_key():
    with pytest.raises(SystemExit, match="AURA_LLM_API_KEY"):
        configure_llm({})
