import asyncio

from main import factory


def test_weather_list_and_run():
    calls = []

    async def fetch_impl(url, **_kwargs):
        calls.append({"url": url})
        return {
            "ok": True,
            "status": 200,
            "json": {
                "latitude": 37.57,
                "longitude": 126.98,
                "timezone": "Asia/Seoul",
                "current": {
                    "time": "2026-11-26T12:00",
                    "temperature_2m": 8.5,
                    "weather_code": 3,
                    "wind_speed_10m": 12.0,
                },
                "daily": {
                    "time": ["2026-11-26"],
                    "temperature_2m_max": [10.0],
                    "temperature_2m_min": [2.0],
                    "precipitation_probability_max": [20],
                },
            },
        }

    mcp = factory({"forecast_days": 1, "fetch_impl": fetch_impl}, None)
    listed = asyncio.run(mcp["listTools"]())
    assert listed["ok"] is True
    assert listed["tools"][0]["name"] == "weather"
    assert "latitude" in listed["tools"][0]["inputSchema"]["properties"]

    ran = asyncio.run(
        mcp["runTool"](
            {
                "tool": "weather",
                "input": {"latitude": 37.5665, "longitude": 126.978},
            }
        )
    )
    assert ran["ok"] is True
    assert ran["tag"] == "scaffold-mcp"
    assert ran["tool"] == "weather"
    assert ran["current"]["temperature_2m"] == 8.5
    assert len(calls) == 1
    assert "api.open-meteo.com/v1/forecast" in calls[0]["url"]
    assert "latitude=37.5665" in calls[0]["url"]


def test_weather_errors():
    async def fetch_impl(_url, **_kwargs):
        raise AssertionError("fetch must not run")

    mcp = factory({"fetch_impl": fetch_impl}, None)
    bad = asyncio.run(mcp["runTool"]({"tool": "nope", "input": {}}))
    assert bad["ok"] is False
    assert bad["error"] == "unknown_tool"

    no_lat = asyncio.run(
        mcp["runTool"]({"tool": "weather", "input": {"longitude": 126.9}})
    )
    assert no_lat["ok"] is False
    assert no_lat["error"] == "latitude_required"
