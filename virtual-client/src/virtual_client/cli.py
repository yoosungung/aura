from __future__ import annotations

import argparse

from virtual_client.scenarios import SCENARIOS

CHANNELS = ("web", "kakao", "email")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="virtual-client")
    parser.add_argument("--channel", choices=[*CHANNELS, "all"], default="web")
    parser.add_argument("--scenario", choices=[*SCENARIOS, "all"], default="all")
    parser.add_argument("--max-turns", type=int, default=8)
    parser.add_argument("--skip-bootstrap", action="store_true")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--kakao-base", default="http://127.0.0.1:8081")
    parser.add_argument("--smtp-host", default="127.0.0.1")
    parser.add_argument("--smtp-port", type=int, default=2050)
    return parser.parse_args(argv)
