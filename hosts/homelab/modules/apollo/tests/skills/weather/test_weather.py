import argparse
import sys
from datetime import date, timedelta

import pytest
import weather

TODAY = date.today()
YESTERDAY = TODAY - timedelta(days=1)
TOMORROW = TODAY + timedelta(days=1)


def run(*argv):
    args = weather.build_parser().parse_args(list(argv))
    args.func(args)


@pytest.fixture
def store(tmp_path, monkeypatch):
    root = tmp_path / "weather"
    monkeypatch.setattr(weather, "WORKSPACE", tmp_path)
    monkeypatch.setattr(weather, "WEATHER_DIR", root)
    monkeypatch.setattr(weather, "CONFIG_FILE", root / "config.json")
    return root


def configured():
    run("config-set", "--place", "Graz", "--lat", "47.06", "--lon", "15.44")


def payload(**over):
    """An Open-Meteo reply shaped like the real one: yesterday, today, tomorrow."""
    days = [YESTERDAY, TODAY, TOMORROW]
    hourly_time = [f"{d.isoformat()}T{h:02d}:00" for d in days for h in range(24)]
    data = {
        "current": {"temperature_2m": 31.4, "weather_code": 2},
        "daily": {
            "time": [d.isoformat() for d in days],
            "weather_code": [80, 2, 3],
            "temperature_2m_max": [33.2, 35.5, 37.1],
            "temperature_2m_min": [20.2, 21.4, 21.0],
            "precipitation_probability_max": [18, 0, 0],
            "sunrise": [f"{days[0].isoformat()}T05:38", f"{days[1].isoformat()}T05:40",
                        f"{days[2].isoformat()}T05:41"],
            "sunset": [f"{days[0].isoformat()}T20:30", f"{days[1].isoformat()}T20:28",
                       f"{days[2].isoformat()}T20:27"],
            "uv_index_max": [6.75, 6.75, 6.7],
            "wind_speed_10m_max": [17.1, 12.2, 15.3],
        },
        "hourly": {
            "time": hourly_time,
            # 12° at night rising to 30° at 19:00, for every day in the payload.
            "temperature_2m": [(12.0 if h < 6 else 23.4 if h == 8 else 30.0 if h == 19 else 25.0)
                               for _ in days for h in range(24)],
        },
    }
    for key, value in over.items():
        data["daily"][key] = value
    return data


@pytest.fixture
def canned(monkeypatch):
    """Serve a fixed payload instead of calling the provider."""
    calls = []

    def fake(spot, days):
        calls.append((spot, days))
        return payload()

    monkeypatch.setattr(weather, "fetch", fake)
    return calls


class TestStore:
    def test_the_place_is_kept_in_the_workspace_not_wherever_this_ran(self):
        assert weather.WEATHER_DIR == weather.WORKSPACE / "weather"
        assert weather.WORKSPACE.is_absolute()


class TestWmo:
    def test_known_code_has_an_icon_and_words(self):
        assert weather.wmo(3) == ("☁️", "overcast")
        assert weather.wmo(95)[1] == "thunderstorms"

    def test_an_unknown_code_still_reads_as_something(self):
        icon, words = weather.wmo(1234)
        assert icon and words == "unsettled"


class TestDaylight:
    def test_length_is_hours_and_minutes(self):
        assert weather.fmt_daylight(14 * 3600 + 48 * 60) == "14h 48m"
        assert weather.fmt_daylight(0) == "0h 0m"

    def test_change_says_which_way_and_against_what(self):
        assert weather.fmt_change(-240, "yesterday") == "4m less than yesterday"
        assert weather.fmt_change(180, "the day before") == "3m more than the day before"

    def test_a_change_under_half_a_minute_is_no_change(self):
        assert weather.fmt_change(-20, "yesterday") == "same as yesterday"

    def test_length_comes_from_sunrise_to_sunset(self):
        assert weather.daylight_seconds(payload(), 1) == 14 * 3600 + 48 * 60


class TestWeatherLine:
    def line(self, i=1, is_today=True, data=None):
        return weather.weather_line(data or payload(), i, "Graz", is_today)

    def test_today_leads_with_the_condition_and_the_current_temperature(self):
        line = self.line()
        assert line.startswith("⛅ Graz: 31° now")
        assert "up to 36°" in line
        assert "partly cloudy" in line
        assert "0% rain" in line

    def test_another_day_names_the_day_and_gives_the_morning_instead_of_now(self):
        line = self.line(i=2, is_today=False)
        assert f"Graz, {TOMORROW:%a %d.%m}:" in line
        assert "23° at 08:00" in line
        assert "now" not in line

    def test_it_says_up_to_rather_than_later_so_it_holds_all_day(self):
        assert "later" not in self.line()

    def test_a_hot_evening_is_called_out(self):
        # 19:00 is 30° against a high of 30°, so the evening brings no relief.
        assert "still 30° at 19:00" in self.line(data=payload(temperature_2m_max=[33, 30, 30]))

    def test_an_ordinary_evening_is_not(self):
        assert "at 19:00" not in self.line(data=payload(temperature_2m_max=[33, 40, 40]))

    def test_high_uv_is_named_and_moderate_uv_is_not(self):
        assert "UV 7" in self.line()
        assert "UV" not in self.line(data=payload(uv_index_max=[3, 3, 3]))

    def test_strong_wind_is_named_and_a_breeze_is_not(self):
        assert "wind 52 km/h" in self.line(data=payload(wind_speed_10m_max=[10, 52, 10]))
        assert "wind" not in self.line()

    def test_a_missing_rain_probability_reads_as_zero(self):
        assert "0% rain" in self.line(data=payload(precipitation_probability_max=[None, None, None]))


class TestDaylightLine:
    def test_it_spans_sunrise_to_sunset_with_the_change(self):
        line = weather.daylight_line(payload(), 1, True)
        assert "05:40 → 20:28" in line
        assert "14h 48m of daylight" in line
        assert "4m less than yesterday" in line

    def test_another_day_compares_with_the_day_before_it(self):
        assert "the day before" in weather.daylight_line(payload(), 2, False)

    def test_the_oldest_day_has_nothing_to_compare_against(self):
        assert "(" not in weather.daylight_line(payload(), 0, False)


class TestShow:
    def test_today_prints_the_two_sky_lines(self, store, canned, capsys):
        configured()
        capsys.readouterr()
        run("show")
        out = capsys.readouterr().out.strip().splitlines()
        assert len(out) == 2
        assert out[0].startswith("⛅ Graz:")
        assert out[1].startswith("🌅")

    def test_a_date_asks_the_provider_for_enough_days(self, store, canned, capsys):
        configured()
        run("show", "--date", TOMORROW.isoformat())
        assert canned[-1][1] == 2

    def test_a_past_date_is_refused(self, store, canned):
        configured()
        with pytest.raises(SystemExit):
            run("show", "--date", YESTERDAY.isoformat())

    def test_a_date_beyond_the_horizon_is_refused_before_calling(self, store, canned):
        configured()
        far = (TODAY + timedelta(days=weather.HORIZON_DAYS + 5)).isoformat()
        with pytest.raises(SystemExit):
            run("show", "--date", far)
        assert canned == []

    def test_an_outlook_is_one_line_per_day(self, store, canned, capsys):
        configured()
        capsys.readouterr()
        run("show", "--days", "2")
        lines = capsys.readouterr().out.strip().splitlines()
        assert lines[0] == "Graz, next 2 days:"
        assert len(lines) == 3
        assert f"{TODAY:%a %d.%m}  21-36°" in lines[1]

    def test_an_impossible_span_is_refused(self, store, canned):
        configured()
        with pytest.raises(SystemExit):
            run("show", "--days", "0")
        with pytest.raises(SystemExit):
            run("show", "--days", str(weather.HORIZON_DAYS + 1))


class TestConfig:
    def test_it_reports_an_unset_place(self, store, capsys):
        run("config")
        assert "not set" in capsys.readouterr().out

    def test_set_then_read_back(self, store, capsys):
        configured()
        assert "Graz (47.06, 15.44)" in capsys.readouterr().out

    def test_the_place_persists_so_it_is_asked_only_once(self, store):
        configured()
        assert weather.place() == {"latitude": 47.06, "longitude": 15.44, "name": "Graz"}

    def test_coordinates_are_required_together(self, store):
        with pytest.raises(SystemExit):
            run("config-set", "--lat", "47.06")

    def test_only_the_label_can_be_changed_afterwards(self, store, capsys):
        configured()
        run("config-set", "--place", "Home")
        assert "Home (47.06, 15.44)" in capsys.readouterr().out

    def test_impossible_coordinates_are_rejected(self):
        with pytest.raises(argparse.ArgumentTypeError):
            weather.latitude("91")
        with pytest.raises(argparse.ArgumentTypeError):
            weather.longitude("-181")

    def test_asking_without_a_place_says_how_to_set_one(self, store, capsys):
        with pytest.raises(SystemExit):
            weather.place()
        assert "config-set" in capsys.readouterr().err


class TestProvider:
    def test_an_error_body_is_a_failure_even_with_a_200(self, store, monkeypatch, capsys):
        # The free service answers {"error": true} with HTTP 200 when it is overloaded.
        monkeypatch.setattr(weather, "RETRY_PAUSE", 0)

        class Resp:
            def read(self):
                return b'{"error": true, "reason": "The service is overloaded"}'

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        monkeypatch.setattr(weather.urllib.request, "urlopen", lambda *a, **k: Resp())
        with pytest.raises(SystemExit):
            weather.fetch({"latitude": 1, "longitude": 2, "name": "x"}, 1)
        assert "overloaded" in capsys.readouterr().err

    def test_it_tries_again_before_giving_up(self, store, monkeypatch):
        monkeypatch.setattr(weather, "RETRY_PAUSE", 0)
        attempts = []

        class Resp:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def flaky(*a, **k):
            attempts.append(1)
            if len(attempts) == 1:
                raise weather.urllib.error.URLError("boom")
            return Resp(b'{"daily": {"time": []}}')

        monkeypatch.setattr(weather.urllib.request, "urlopen", flaky)
        assert weather.fetch({"latitude": 1, "longitude": 2, "name": "x"}, 1) == {"daily": {"time": []}}
        assert len(attempts) == 2


class TestAudience:
    def invoke(self, monkeypatch, *argv):
        monkeypatch.setattr(sys, "argv", ["weather.py", *argv])
        weather.main()

    def spy(self, monkeypatch):
        sent = []

        def fake(text):
            sent.append(text)
            return "\n[weather: delivered to the user \u2713]\n"

        monkeypatch.setattr(weather, "deliver_to_user", fake)
        return sent

    def test_the_sky_is_written_for_the_user(self, store, canned, monkeypatch, capsys):
        configured()
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "show")
        assert len(sent) == 1
        assert "Graz" in sent[0]
        assert "delivered to the user" in capsys.readouterr().out

    def test_quiet_sends_nothing_and_says_so(self, store, canned, monkeypatch, capsys):
        configured()
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "show", "--quiet")
        out = capsys.readouterr().out
        assert sent == []
        assert "Graz" in out
        assert "quiet - not sent to the user" in out

    def test_the_place_it_is_set_to_reaches_the_user(self, store, monkeypatch):
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "config-set", "--place", "Graz", "--lat", "47.06", "--lon", "15.44")
        assert len(sent) == 1
        assert "Graz" in sent[0]

    def test_reading_the_settings_back_is_for_the_caller(self, store, monkeypatch, capsys):
        configured()
        sent = self.spy(monkeypatch)
        capsys.readouterr()
        self.invoke(monkeypatch, "config")
        assert sent == []
        assert "Graz" in capsys.readouterr().out

    def test_only_the_forecast_can_be_read_without_sending_it(self):
        parser = weather.build_parser()
        assert parser.parse_args(["show", "--quiet"]).quiet is True
        for argv in (["config"], ["config-set", "--place", "x"]):
            assert parser.parse_args(argv).quiet is False, argv
            with pytest.raises(SystemExit):
                parser.parse_args([*argv, "--quiet"])


