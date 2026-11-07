from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

DAY_KEYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")


def open_now(now: datetime, enabled: bool, raw: Any) -> bool:
    """Match backend/internal/routing/hours.go OpenNow."""
    if not enabled:
        return True
    hours = parse_hours(raw)
    if hours is None:
        return True
    loc = hours_loc(hours)
    t = now.astimezone(loc)
    window = window_on(t, hours)
    if window is None:
        return False
    open_at, close_at = window
    return open_at <= t < close_at


def parse_hours(raw: Any) -> dict | None:
    if raw is None or raw == "" or raw == b"" or raw == {}:
        return None
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode()
    if isinstance(raw, str):
        if raw in ("", "null", "{}"):
            return None
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None
    if not isinstance(raw, dict):
        return None
    week = raw.get("week") or {}
    if not week:
        return None
    return {"timezone": raw.get("timezone") or "", "week": week}


def hours_loc(hours: dict):
    tz = hours.get("timezone") or ""
    if not tz:
        return timezone.utc
    try:
        return ZoneInfo(tz)
    except Exception:
        return timezone.utc


def window_on(t: datetime, hours: dict) -> tuple[datetime, datetime] | None:
    # Python weekday Mon=0..Sun=6 → Go/dayKeys Sun=0..Sat=6
    key = DAY_KEYS[(t.weekday() + 1) % 7]
    slots = (hours.get("week") or {}).get(key) or []
    if not slots:
        return None
    day = t.replace(hour=0, minute=0, second=0, microsecond=0)
    for slot in slots:
        if not isinstance(slot, (list, tuple)) or len(slot) != 2:
            continue
        oh, om, ok1 = parse_clock(slot[0])
        ch, cm, ok2 = parse_clock(slot[1])
        if not ok1 or not ok2:
            continue
        open_at = day.replace(hour=oh, minute=om)
        close_at = day.replace(hour=ch, minute=cm)
        if close_at > open_at:
            return open_at, close_at
    return None


def parse_clock(s: Any) -> tuple[int, int, bool]:
    if not isinstance(s, str) or len(s) != 5 or s[2] != ":":
        return 0, 0, False
    try:
        hour = int(s[0:2])
        minute = int(s[3:5])
    except ValueError:
        return 0, 0, False
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return 0, 0, False
    return hour, minute, True
