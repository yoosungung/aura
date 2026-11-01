from __future__ import annotations

import argparse
import os

from virtual_client.scenarios import SCENARIOS

CHANNELS = ("web", "kakao", "email")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="virtual-client")
    parser.add_argument("--channel", choices=[*CHANNELS, "all"], default="web")
    parser.add_argument("--scenario", choices=[*SCENARIOS, "all"], default="all")
    parser.add_argument("--max-turns", type=int, default=8)
    parser.add_argument("--skip-bootstrap", action="store_true")
    parser.add_argument("--base", default=os.environ.get("AURA_GATEWAY_URL") or "http://127.0.0.1:30080")
    parser.add_argument("--kakao-base", default=os.environ.get("AURA_KAKAO_URL") or "http://127.0.0.1:30081")
    parser.add_argument("--smtp-host", default=os.environ.get("AURA_SMTP_HOST") or "127.0.0.1")
    parser.add_argument("--smtp-port", type=int, default=int(os.environ.get("AURA_SMTP_PORT") or "30025"))
    return parser.parse_args(argv)
