"""Open-Meteo forecast helper for mcp-python scaffold (stdlib; no API key)."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Mapping, Optional

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


def _as_float(v: Any, name: str) -> tuple[Optional[float], Optional[dict[str, Any]]]:
    if v is None or v == "":
        return None, {"ok": False, "error": f"{name}_required"}
    try:
        return float(v), None
    except (TypeError, ValueError):
        return None, {"ok": False, "error": f"{name}_invalid"}


async def fetch_weather(
    *,
    latitude: Any,
    longitude: Any,
    forecast_days: Any = 1,
    timezone: Any = "auto",
    fetch_impl: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    lat, err = _as_float(latitude, "latitude")
    if err:
        return err
    lon, err = _as_float(longitude, "longitude")
    if err:
        return err
    if lat is None or lon is None or not (-90.0 <= lat <= 90.0):
        return {"ok": False, "error": "latitude_invalid"}
    if not (-180.0 <= lon <= 180.0):
        return {"ok": False, "error": "longitude_invalid"}

    try:
        days = 1 if forecast_days is None or forecast_days == "" else int(forecast_days)
    except (TypeError, ValueError):
        return {"ok": False, "error": "forecast_days_invalid"}
    days = max(1, min(16, days))
    tz = str(timezone or "auto")

    params = {
        "latitude": str(lat),
        "longitude": str(lon),
        "current": "temperature_2m,weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "forecast_days": str(days),
        "timezone": tz,
    }
    url = FORECAST_URL + "?" + urllib.parse.urlencode(params)

    if fetch_impl is not None:
        res = await fetch_impl(url)
        if not isinstance(res, Mapping) or not res.get("ok", True):
            status = res.get("status", 0) if isinstance(res, Mapping) else 0
            return {"ok": False, "error": "upstream_error", "status": status}
        body = res.get("json") if isinstance(res, Mapping) else None
        if body is None:
            body = res
    else:
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": "upstream_error", "status": exc.code}
        except Exception:
            return {"ok": False, "error": "upstream_error", "status": 0}

    if not isinstance(body, Mapping):
        return {"ok": False, "error": "upstream_error", "status": 0}

    current = body.get("current") if isinstance(body.get("current"), Mapping) else {}
    daily = body.get("daily") if isinstance(body.get("daily"), Mapping) else {}
    return {
        "ok": True,
        "latitude": body.get("latitude", lat),
        "longitude": body.get("longitude", lon),
        "timezone": body.get("timezone", tz),
        "current": {
            "time": current.get("time"),
            "temperature_2m": current.get("temperature_2m"),
            "weather_code": current.get("weather_code"),
            "wind_speed_10m": current.get("wind_speed_10m"),
        },
        "daily": {
            "time": daily.get("time") or [],
            "temperature_2m_max": daily.get("temperature_2m_max") or [],
            "temperature_2m_min": daily.get("temperature_2m_min") or [],
            "precipitation_probability_max": daily.get("precipitation_probability_max") or [],
        },
        "forecast_days": days,
    }
