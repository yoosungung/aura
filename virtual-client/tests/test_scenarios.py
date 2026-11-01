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
