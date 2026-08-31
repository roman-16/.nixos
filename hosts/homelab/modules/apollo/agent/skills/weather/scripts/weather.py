#!/usr/bin/env python3
"""Weather and daylight for Apollo.

Owns the sky: what it will be like today, and how much light the day has. Both come from one
call against one coordinate pair, which is why they live in one skill rather than two.

The place is stored in weather/config.json in the workspace and is set once through config-set, the
same way the offers skill is told a postcode: nothing is hardcoded, so the answer is never quietly
about the wrong town.

Forecasts come from Open-Meteo, which needs no API key and serves the national models - for
central Europe DWD's ICON-D2 at 2 km. That is an implementation detail of fetch() and never
appears in what the user reads. Sunrise and sunset are astronomy rather than forecast, so the
daylight line is exact whatever the weather does.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta
from pathlib import Path

# Anchored to the workspace rather than the working directory, because where this script is run from
# says nothing about where the user's location is kept - and a config looked for in the wrong place
# reads exactly like a location nobody ever set.
WORKSPACE = Path(os.environ.get("APOLLO_WORKSPACE") or Path.home() / "workspace")
WEATHER_DIR = WORKSPACE / "weather"
CONFIG_FILE = WEATHER_DIR / "config.json"

API = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 15
# The free service has occasional blips, and this is asked for a message that goes out once a day,
# so it is worth waiting between tries rather than firing them all into the same bad second.
ATTEMPTS = 3
RETRY_PAUSE = 2

# How far ahead the provider forecasts, and how many days an outlook may ask for.
HORIZON_DAYS = 16

# Clauses that earn their place only sometimes. The line should be the same shape every day, but
# it must not hide a hazard, so each of these appears only when it says something.
UV_HIGH = 6  # WHO calls 6-7 high
WIND_STRONG = 40  # km/h
EVENING_HOUR = 19
EVENING_CLOSE = 3  # within this many degrees of the day's high means no evening relief

# WMO weather interpretation codes, as an icon and the words to print.
WMO = {
    0: ("☀️", "clear"),
    1: ("🌤️", "mainly clear"),
    2: ("⛅", "partly cloudy"),
    3: ("☁️", "overcast"),
    45: ("🌫️", "fog"),
    48: ("🌫️", "freezing fog"),
    51: ("🌦️", "light drizzle"),
    53: ("🌦️", "drizzle"),
    55: ("🌦️", "heavy drizzle"),
    56: ("🌧️", "freezing drizzle"),
    57: ("🌧️", "heavy freezing drizzle"),
    61: ("🌧️", "light rain"),
    63: ("🌧️", "rain"),
    65: ("🌧️", "heavy rain"),
    66: ("🌧️", "freezing rain"),
    67: ("🌧️", "heavy freezing rain"),
    71: ("🌨️", "light snow"),
    73: ("🌨️", "snow"),
    75: ("🌨️", "heavy snow"),
    77: ("🌨️", "snow grains"),
    80: ("🌦️", "light rain showers"),
    81: ("🌦️", "rain showers"),
    82: ("⛈️", "violent rain showers"),
    85: ("🌨️", "snow showers"),
    86: ("🌨️", "heavy snow showers"),
    95: ("⛈️", "thunderstorms"),
    96: ("⛈️", "thunderstorms with hail"),
    99: ("⛈️", "thunderstorms with heavy hail"),
}

DAILY = (
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
    "sunrise,sunset,uv_index_max,wind_speed_10m_max"
)


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# --- storage -------------------------------------------------------------


def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def place() -> dict:
    """The configured place. Asking beats assuming: an unset place says so rather than
    reporting the weather somewhere the user does not live."""
    config = load(CONFIG_FILE, {})
    if config.get("latitude") is None or config.get("longitude") is None:
        die("no place set yet - ask the user for their coordinates once, then: "
            "weather.py config-set --place Graz --lat 47.07 --lon 15.44")
    return {
        "latitude": config["latitude"],
        "longitude": config["longitude"],
        "name": config.get("place") or "here",
    }


def latitude(value: str) -> float:
    x = float(value)
    if not -90 <= x <= 90:
        raise argparse.ArgumentTypeError("latitude must be between -90 and 90")
    return x


def longitude(value: str) -> float:
    x = float(value)
    if not -180 <= x <= 180:
        raise argparse.ArgumentTypeError("longitude must be between -180 and 180")
    return x


def parse_date(value: str) -> date:
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except ValueError:
        die(f'invalid date "{value}" (use YYYY-MM-DD)')


# --- provider ------------------------------------------------------------


def fetch(spot: dict, days: int) -> dict:
    """The forecast, with yesterday included so the daylight line can say how the day changed.

    Retries once, because this is asked for a message that goes out on a schedule and the free
    service occasionally answers "overloaded" - with HTTP 200, which is why the body is checked
    rather than the status.
    """
    query = urllib.parse.urlencode({
        "current": "temperature_2m,weather_code",
        "daily": DAILY,
        "forecast_days": days,
        "hourly": "temperature_2m",
        "latitude": spot["latitude"],
        "longitude": spot["longitude"],
        "past_days": 1,
        "timezone": "auto",
    })
    last = ""
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(RETRY_PAUSE)
        try:
            with urllib.request.urlopen(f"{API}?{query}", timeout=TIMEOUT) as response:
                data = json.loads(response.read())
            if not data.get("error"):
                return data
            last = str(data.get("reason") or "unknown reason")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = str(error)
    die(f"could not reach the weather service ({last})")


# --- rendering -----------------------------------------------------------


def wmo(code) -> tuple:
    return WMO.get(code, ("🌡️", "unsettled"))


def index_of(data: dict, day: date) -> int:
    """Where a date sits in the daily arrays."""
    try:
        return data["daily"]["time"].index(day.isoformat())
    except ValueError:
        die(f"no forecast for {day.isoformat()} - it is outside the {HORIZON_DAYS}-day horizon")


def hour_temp(data: dict, day: str, hour: int):
    """The temperature at a given hour of a given day, or None when it is not in the series."""
    stamp = f"{day}T{hour:02d}:00"
    hourly = data.get("hourly") or {}
    try:
        return hourly["temperature_2m"][hourly["time"].index(stamp)]
    except (KeyError, ValueError, IndexError):
        return None


def daylight_seconds(data: dict, i: int) -> int:
    rise = datetime.fromisoformat(data["daily"]["sunrise"][i])
    down = datetime.fromisoformat(data["daily"]["sunset"][i])
    return int((down - rise).total_seconds())


def fmt_daylight(seconds: int) -> str:
    return f"{seconds // 3600}h {seconds % 3600 // 60}m"


def fmt_change(seconds: int, previous_label: str) -> str:
    """How the day's length compares with the day before, which is the reason to state it at all."""
    minutes = round(abs(seconds) / 60)
    if minutes == 0:
        return f"same as {previous_label}"
    return f"{minutes}m {'less' if seconds < 0 else 'more'} than {previous_label}"


def day_label(day: date) -> str:
    return f"{day:%a %d.%m}"


def weather_line(data: dict, i: int, name: str, is_today: bool) -> str:
    daily = data["daily"]
    icon, words = wmo(daily["weather_code"][i])
    high = daily["temperature_2m_max"][i]
    parts = []
    if is_today:
        now = (data.get("current") or {}).get("temperature_2m")
        if now is not None:
            parts.append(f"{round(now)}° now")
    else:
        morning = hour_temp(data, daily["time"][i], 8)
        if morning is not None:
            parts.append(f"{round(morning)}° at 08:00")
    # "up to" rather than "later", so the line is still true when the peak has passed.
    parts.append(f"up to {round(high)}°")
    evening = hour_temp(data, daily["time"][i], EVENING_HOUR)
    if evening is not None and high - evening <= EVENING_CLOSE:
        parts.append(f"still {round(evening)}° at {EVENING_HOUR}:00")
    parts.append(words)
    parts.append(f"{round(daily['precipitation_probability_max'][i] or 0)}% rain")
    uv = daily["uv_index_max"][i]
    if uv is not None and uv >= UV_HIGH:
        parts.append(f"UV {round(uv)}")
    wind = daily["wind_speed_10m_max"][i]
    if wind is not None and wind >= WIND_STRONG:
        parts.append(f"wind {round(wind)} km/h")
    where = name if is_today else f"{name}, {day_label(date.fromisoformat(daily['time'][i]))}"
    return f"{icon} {where}: {', '.join(parts)}"


def daylight_line(data: dict, i: int, is_today: bool) -> str:
    daily = data["daily"]
    rise = datetime.fromisoformat(daily["sunrise"][i])
    down = datetime.fromisoformat(daily["sunset"][i])
    today_light = daylight_seconds(data, i)
    change = ""
    if i > 0:
        change = f" ({fmt_change(today_light - daylight_seconds(data, i - 1), 'yesterday' if is_today else 'the day before')})"
    return f"🌅 {rise:%H:%M} → {down:%H:%M} · {fmt_daylight(today_light)} of daylight{change}"


def sky(data: dict, i: int, name: str, is_today: bool) -> str:
    return f"{weather_line(data, i, name, is_today)}\n{daylight_line(data, i, is_today)}"


def outlook(data: dict, name: str, days: int, first: int) -> str:
    lines = [f"{name}, next {days} days:"]
    for i in range(first, min(first + days, len(data["daily"]["time"]))):
        daily = data["daily"]
        icon, words = wmo(daily["weather_code"][i])
        low = round(daily["temperature_2m_min"][i])
        high = round(daily["temperature_2m_max"][i])
        rain = round(daily["precipitation_probability_max"][i] or 0)
        day = date.fromisoformat(daily["time"][i])
        lines.append(f"{icon} {day_label(day)}  {low}-{high}°  {words}, {rain}% rain")
    return "\n".join(lines)


# --- commands ------------------------------------------------------------


def cmd_show(args):
    spot = place()
    today = date.today()
    if args.days is not None:
        if args.days < 1 or args.days > HORIZON_DAYS:
            die(f"--days must be between 1 and {HORIZON_DAYS}")
        data = fetch(spot, args.days)
        print(outlook(data, spot["name"], args.days, index_of(data, today)))
        return
    day = parse_date(args.date) if args.date else today
    ahead = (day - today).days
    if ahead < 0:
        die("that day is in the past - ask for a date from today onwards")
    if ahead + 1 > HORIZON_DAYS:
        die(f"{day.isoformat()} is beyond the {HORIZON_DAYS}-day forecast horizon")
    data = fetch(spot, ahead + 1)
    print(sky(data, index_of(data, day), spot["name"], day == today))


def cmd_config(args):
    config = load(CONFIG_FILE, {})
    if config.get("latitude") is None:
        print("Place: not set")
        return
    print(f"Place: {config.get('place') or 'unnamed'} "
          f"({config['latitude']}, {config['longitude']})")


def cmd_config_set(args):
    config = load(CONFIG_FILE, {})
    if args.place is not None:
        config["place"] = args.place
    if args.lat is not None:
        config["latitude"] = args.lat
    if args.lon is not None:
        config["longitude"] = args.lon
    if config.get("latitude") is None or config.get("longitude") is None:
        die("give both --lat and --lon")
    save(CONFIG_FILE, config)
    cmd_config(args)


# --- delivery ------------------------------------------------------------


def deliver_to_user(text: str) -> str | None:
    """POST the reply to the app's localhost hook, which delivers it to the user on WhatsApp and
    returns the marker to print. Returns the response body (the marker); None only if the app
    could not be reached at all - the one case the caller falls back for."""
    port = os.environ.get("PORT", "8080")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-message?source=weather",
        data=text.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.read().decode("utf-8")
    except Exception:
        return None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="weather.py", description="weather and daylight")
    sub = p.add_subparsers(dest="cmd", required=True)

    # `delivers` marks the commands whose output is written for the user.
    def command(name: str, *, delivers: bool = False) -> argparse.ArgumentParser:
        parser = sub.add_parser(name)
        parser.set_defaults(delivers=delivers, quiet=False)
        return parser

    sh = command("show", delivers=True)
    sh.set_defaults(func=cmd_show)
    # A forecast is the world's, not the user's, so the agent may read one to answer in its own words
    # - and the briefing composes this one into a single morning message.
    sh.add_argument("--quiet", action="store_true",
                    help="print the result here instead of sending it to the user")
    group = sh.add_mutually_exclusive_group()
    group.add_argument("--date", help="a day from today onwards (YYYY-MM-DD)")
    group.add_argument("--days", type=int, help="a compact outlook over this many days")

    command("config").set_defaults(func=cmd_config)

    cs = command("config-set", delivers=True)
    cs.set_defaults(func=cmd_config_set)
    cs.add_argument("--place")
    cs.add_argument("--lat", type=latitude)
    cs.add_argument("--lon", type=longitude)

    return p


def main():
    args = build_parser().parse_args()
    if not WORKSPACE.is_dir():
        die(f"no workspace at {WORKSPACE} - this is not where the user's data is")
    # Capture the command's output so it can be delivered to the user directly, while still writing
    # it to stdout so the caller sees it (for its reasoning and to detect delivery success/failure).
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            args.func(args)
    finally:
        sys.stdout.write(buffer.getvalue())
    output = buffer.getvalue()
    if not output.strip() or not args.delivers:
        return
    if args.quiet:
        # Say so explicitly: without a marker the caller cannot tell a silent run from a sent one.
        sys.stdout.write("\n[weather: quiet - not sent to the user]\n")
        return
    marker = deliver_to_user(output)
    sys.stdout.write(
        marker
        if marker is not None
        else "\n[weather: delivery FAILED - relay the output above to the user yourself]\n"
    )


if __name__ == "__main__":
    main()
