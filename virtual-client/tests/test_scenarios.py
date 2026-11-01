import subprocess
from pathlib import Path

from virtual_client.cli import parse_args
from virtual_client.scenarios import SCENARIOS, get_scenario


def test_five_scenarios_have_persona_goal_criteria():
    assert set(SCENARIOS) == {
        "cancel-in-transit",
        "lost-package",
        "return-fee",
        "damaged-exchange",
        "coupon-retro",
    }
    for item in SCENARIOS.values():
        assert item.persona
        assert item.goal
        assert len(item.criteria) == 3


def test_cli_parses_channel_and_scenario():
    args = parse_args(["--channel", "all", "--scenario", "lost-package", "--max-turns", "6"])
    assert args.channel == "all"
    assert args.scenario == "lost-package"
    assert args.max_turns == 6
    assert get_scenario("lost-package").name == "lost-package"


def test_cli_defaults_to_k8s_nodeports(monkeypatch):
    for key in ("AURA_GATEWAY_URL", "AURA_KAKAO_URL", "AURA_SMTP_HOST", "AURA_SMTP_PORT"):
        monkeypatch.delenv(key, raising=False)
    args = parse_args([])
    assert args.base == "http://127.0.0.1:30080"
    assert args.kakao_base == "http://127.0.0.1:30081"
    assert args.smtp_host == "127.0.0.1"
    assert args.smtp_port == 30025


def test_cli_env_overrides_gateway(monkeypatch):
    monkeypatch.setenv("AURA_GATEWAY_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("AURA_KAKAO_URL", "http://127.0.0.1:8081")
    monkeypatch.setenv("AURA_SMTP_PORT", "2050")
    args = parse_args([])
    assert args.base == "http://127.0.0.1:8080"
    assert args.kakao_base == "http://127.0.0.1:8081"
    assert args.smtp_port == 2050


def test_run_sh_help():
    script = Path(__file__).resolve().parents[1] / "run.sh"
    out = subprocess.run([str(script), "--help"], check=True, capture_output=True, text=True)
    assert "--channel" in out.stdout
    assert "--scenario" in out.stdout


def test_run_sh_fails_when_gateway_down():
    script = Path(__file__).resolve().parents[1] / "run.sh"
    out = subprocess.run(
        [str(script), "--base", "http://127.0.0.1:9", "--channel", "web"],
        capture_output=True,
        text=True,
    )
    assert out.returncode != 0
    assert "응답하지 않습니다" in out.stderr
    assert "http://127.0.0.1:9" in out.stderr
