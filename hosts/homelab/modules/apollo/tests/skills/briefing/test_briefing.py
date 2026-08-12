import json
import sys
from datetime import date

import briefing
import pytest

DAY = date(2026, 8, 3)
SKY = "⛅ Graz: 31° now, up to 36°, partly cloudy, 0% rain\n🌅 05:40 → 20:28 · 14h 48m of daylight"
OFFERS = "🏷️ Offers\n\n*Red Bull*\n  €0.99 · BILLA · until Wed 05.08"


def event(**over):
    base = {
        "all_day": False,
        "end": "2026-08-03T22:00:00+02:00",
        "location": "",
        "start": "2026-08-03T19:00:00+02:00",
        "title": "Book club",
    }
    return {**base, **over}


class TestCalendarWindow:
    def test_both_ends_name_the_day_itself(self):
        # --end is the last day included. The range is only a request: what is on the day is settled
        # by covers(), which is why the exact range carries no weight.
        assert briefing.calendar_window(DAY) == ("2026-08-03", "2026-08-03")


class TestCovers:
    """What the provider returns is wider than what it was asked for, at both ends, so membership of
    a day is decided here."""

    def test_a_timed_event_on_the_day(self):
        assert briefing.covers(event(), DAY) is True

    def test_a_timed_event_on_another_day(self):
        tomorrow = event(start="2026-08-04T19:00:00+02:00", end="2026-08-04T22:00:00+02:00")
        assert briefing.covers(tomorrow, DAY) is False

    def test_an_event_that_runs_past_midnight_is_on_both_days(self):
        late = event(start="2026-08-03T22:00:00+02:00", end="2026-08-04T03:00:00+02:00")
        assert briefing.covers(late, DAY) is True
        assert briefing.covers(late, date(2026, 8, 4)) is True

    def test_an_all_day_event_that_ends_where_it_starts_is_one_day(self):
        # One of the two conventions in the same account: a recurring all-day event repeats its start.
        piano = event(all_day=True, start="2026-08-03T00:00:00Z", end="2026-08-03T00:00:00Z")
        assert briefing.covers(piano, DAY) is True
        assert briefing.covers(piano, date(2026, 8, 4)) is False

    def test_an_all_day_event_that_ends_the_next_midnight_is_also_one_day(self):
        holiday = event(all_day=True, start="2026-08-03T00:00:00Z", end="2026-08-04T00:00:00Z")
        assert briefing.covers(holiday, DAY) is True
        assert briefing.covers(holiday, date(2026, 8, 4)) is False

    def test_a_multi_day_all_day_event_covers_every_day_it_runs(self):
        festival = event(all_day=True, start="2026-08-01T00:00:00Z", end="2026-08-04T00:00:00Z")
        for day in (date(2026, 8, 1), date(2026, 8, 2), DAY):
            assert briefing.covers(festival, day) is True
        assert briefing.covers(festival, date(2026, 7, 31)) is False
        assert briefing.covers(festival, date(2026, 8, 4)) is False

    def test_an_event_with_no_end_is_on_its_start_day_alone(self):
        assert briefing.covers(event(end=None), DAY) is True
        assert briefing.covers(event(end=None), date(2026, 8, 4)) is False

    def test_a_timed_event_belongs_to_the_day_it_falls_on_locally(self):
        # An imported invitation comes back in UTC, and 23:00Z in summer is the small hours of the
        # next day here - so reading the date off the timestamp as written puts it on the wrong day.
        late = event(start="2026-08-03T23:00:00Z", end="2026-08-04T00:30:00Z")
        assert briefing.covers(late, date(2026, 8, 4)) is True
        assert briefing.covers(late, DAY) is False

    def test_an_all_day_marker_is_read_as_written(self):
        # It names a date rather than an instant, so it is never moved between zones.
        assert briefing.covers(event(all_day=True, start="2026-08-03T00:00:00Z",
                                     end="2026-08-04T00:00:00Z"), DAY) is True

    def test_an_event_ending_at_midnight_does_not_reach_into_the_next_day(self):
        # The end is where it stops, not a day it is on.
        midnight = event(start="2026-08-03T22:00:00+02:00", end="2026-08-04T00:00:00+02:00")
        assert briefing.covers(midnight, DAY) is True
        assert briefing.covers(midnight, date(2026, 8, 4)) is False

    def test_an_unreadable_start_is_on_no_day_and_says_so(self, capsys):
        assert briefing.covers(event(start="whenever"), DAY) is False
        assert "unreadable start" in capsys.readouterr().err


class TestDefaultCalendar:
    def reply(self, monkeypatch, out):
        monkeypatch.setattr(briefing, "run", lambda command, timeout: out)

    def test_it_reads_the_id_from_the_account(self, monkeypatch):
        self.reply(monkeypatch, json.dumps({"view": "month", "default_calendar": "cal-1"}))
        assert briefing.default_calendar() == "cal-1"

    def test_a_failed_read_is_no_calendar(self, monkeypatch):
        self.reply(monkeypatch, None)
        assert briefing.default_calendar() is None

    def test_unreadable_json_is_no_calendar(self, monkeypatch, capsys):
        self.reply(monkeypatch, "not json")
        assert briefing.default_calendar() is None
        assert "unreadable json" in capsys.readouterr().err

    def test_a_missing_setting_is_no_calendar(self, monkeypatch):
        self.reply(monkeypatch, json.dumps({"view": "month"}))
        assert briefing.default_calendar() is None


class TestFetchEvents:
    def stub(self, monkeypatch, events, *, calendar="cal-1"):
        commands = []

        def fake_run(command, timeout):
            commands.append(command)
            if "settings" in command:
                return json.dumps({"default_calendar": calendar}) if calendar else None
            return json.dumps({"events": events, "count": len(events)})

        monkeypatch.setattr(briefing, "run", fake_run)
        return commands

    def listing(self, commands):
        return next(command for command in commands if "events" in command)

    def test_it_lists_the_default_calendar_alone(self, monkeypatch):
        commands = self.stub(monkeypatch, [event()])
        briefing.fetch_events(DAY)
        listing = self.listing(commands)
        assert listing[listing.index("--calendar") + 1] == "cal-1"

    def test_it_asks_for_the_day_itself(self, monkeypatch):
        commands = self.stub(monkeypatch, [])
        briefing.fetch_events(DAY)
        listing = self.listing(commands)
        assert listing[listing.index("--start") + 1] == "2026-08-03"
        assert listing[listing.index("--end") + 1] == "2026-08-03"

    def test_it_keeps_only_what_is_on_the_day(self, monkeypatch):
        self.stub(monkeypatch, [
            event(title="today"),
            event(title="tomorrow", start="2026-08-04T19:00:00+02:00",
                  end="2026-08-04T20:00:00+02:00"),
            event(title="the day after", all_day=True, start="2026-08-05T00:00:00Z",
                  end="2026-08-05T00:00:00Z"),
        ])
        assert [e["title"] for e in briefing.fetch_events(DAY)] == ["today"]

    def test_a_day_with_nothing_on_it_is_empty_rather_than_unavailable(self, monkeypatch):
        self.stub(monkeypatch, [])
        assert briefing.fetch_events(DAY) == []

    def test_an_unresolvable_default_calendar_reads_as_unavailable(self, monkeypatch):
        commands = self.stub(monkeypatch, [event()], calendar=None)
        assert briefing.fetch_events(DAY) is None
        assert not any("events" in command for command in commands)


class TestReadEvents:
    def test_it_reads_the_events_out_of_the_envelope(self):
        assert briefing.read_events('{"events": [{"title": "Book club"}], "count": 1}') == [
            {"title": "Book club"}
        ]

    def test_an_empty_day_is_no_events_rather_than_no_calendar(self):
        # [] leaves the calendar block out; None would claim the calendar was unavailable.
        assert briefing.read_events('{"events": [], "count": 0}') == []

    def test_a_reply_that_is_not_an_envelope_is_not_a_day(self):
        assert briefing.read_events('[{"title": "Book club"}]') is None

    def test_an_envelope_of_something_else_is_not_a_day(self):
        assert briefing.read_events('{"items": [], "count": 0}') is None

    def test_unreadable_json_says_so_and_reads_as_unavailable(self, capsys):
        assert briefing.read_events("not json") is None
        assert "unreadable json" in capsys.readouterr().err

    def test_nothing_at_all_reads_as_unavailable(self):
        assert briefing.read_events("") is None


class TestEventWhen:
    def test_a_timed_event_shows_its_span(self):
        assert briefing.event_when(event(), DAY) == "19:00-22:00"

    def test_a_utc_timestamp_is_shown_on_the_users_clock(self):
        # The provider stores an imported invitation in UTC; 14:00Z is a 16:00 appointment, and
        # printing the wall clock off the string would put the user in the wrong place two hours early.
        utc = event(start="2026-08-03T14:00:00Z", end="2026-08-03T15:00:00Z")
        assert briefing.event_when(utc, DAY) == "16:00-17:00"

    def test_an_all_day_event_says_so(self):
        assert briefing.event_when(event(all_day=True), DAY) == "all day"

    def test_an_event_with_no_end_shows_only_its_start(self):
        assert briefing.event_when(event(end=None), DAY) == "19:00"

    def test_an_instant_shows_only_its_start(self):
        assert briefing.event_when(event(end="2026-08-03T19:00:00+02:00"), DAY) == "19:00"

    def test_an_event_that_began_yesterday_is_described_by_today(self):
        running = event(start="2026-08-02T21:00:00+02:00", end="2026-08-03T09:00:00+02:00")
        assert briefing.event_when(running, DAY) == "until 09:00"

    def test_an_event_that_runs_into_tomorrow_says_when_it_starts(self):
        late = event(start="2026-08-03T22:00:00+02:00", end="2026-08-04T03:00:00+02:00")
        assert briefing.event_when(late, DAY) == "from 22:00"

    def test_an_event_covering_the_whole_day_is_all_day(self):
        spanning = event(start="2026-08-01T10:00:00+02:00", end="2026-08-05T10:00:00+02:00")
        assert briefing.event_when(spanning, DAY) == "all day"

    def test_an_unreadable_start_does_not_crash_the_briefing(self):
        assert briefing.event_when(event(start="whenever"), DAY) == "all day"


class TestCalendarBlock:
    def test_it_lists_events_under_a_heading(self):
        block = briefing.calendar_block([event()], DAY)
        assert block.splitlines()[0] == "📅 Today"
        assert "19:00-22:00" in block
        assert "Book club" in block

    def test_a_location_is_appended(self):
        assert "· Annenstraße 12" in briefing.calendar_block(
            [event(location="Annenstraße 12")], DAY)

    def test_an_untitled_event_still_appears(self):
        assert "(untitled)" in briefing.calendar_block([event(title="")], DAY)

    def test_all_day_events_come_first_then_the_day_in_order(self):
        events = [
            event(title="Evening", start="2026-08-03T19:00:00+02:00"),
            event(title="Morning", start="2026-08-03T09:00:00+02:00"),
            event(title="Holiday", all_day=True),
        ]
        block = briefing.calendar_block(events, DAY)
        assert block.index("Holiday") < block.index("Morning") < block.index("Evening")


class TestStripMarkers:
    def test_a_caller_note_never_reaches_the_user(self):
        assert briefing.strip_markers("hello\n[offers: quiet - not sent to the user]") == "hello"

    def test_a_hint_line_is_dropped_too(self):
        assert briefing.strip_markers("[offers] pin the watch\nhello") == "hello"

    def test_ordinary_bracketed_text_survives(self):
        assert briefing.strip_markers("€0.99 [see leaflet]") == "€0.99 [see leaflet]"

    def test_nothing_but_markers_leaves_nothing(self):
        assert briefing.strip_markers("[weather: quiet - not sent to the user]") == ""


class TestCompose:
    def test_the_day_leads_the_message(self):
        assert briefing.compose(DAY, SKY, [], "").splitlines()[0] == "*Monday 03.08*"

    def test_a_quiet_day_is_just_the_sky(self):
        message = briefing.compose(DAY, SKY, [], "")
        assert message == f"*Monday 03.08*\n\n{SKY}"

    def test_an_empty_calendar_says_nothing_at_all(self):
        assert "📅" not in briefing.compose(DAY, SKY, [], "")

    def test_events_appear_when_there_are_any(self):
        assert "📅 Today" in briefing.compose(DAY, SKY, [event()], "")

    def test_empty_offers_say_nothing_at_all(self):
        assert "🏷️" not in briefing.compose(DAY, SKY, [], "")

    def test_offers_appear_when_there_are_any(self):
        assert "Red Bull" in briefing.compose(DAY, SKY, [], OFFERS)

    def test_sections_are_separated_by_a_blank_line(self):
        message = briefing.compose(DAY, SKY, [event()], OFFERS)
        assert "\n\n📅 Today" in message
        assert "\n\n🏷️ Offers" in message

    def test_the_order_is_sky_then_calendar_then_offers(self):
        message = briefing.compose(DAY, SKY, [event()], OFFERS)
        assert message.index("🌅") < message.index("📅") < message.index("🏷️")

    def test_a_broken_section_says_so_because_silence_would_read_as_good_news(self):
        assert "Weather unavailable" in briefing.compose(DAY, None, [], "")
        assert "Calendar unavailable" in briefing.compose(DAY, SKY, None, "")
        assert "Offers unavailable" in briefing.compose(DAY, SKY, [], None)

    def test_a_failure_never_stops_the_rest_going_out(self):
        message = briefing.compose(DAY, None, [event()], OFFERS)
        assert "Weather unavailable" in message
        assert "Book club" in message
        assert "Red Bull" in message


class TestAudience:
    def invoke(self, monkeypatch, *argv):
        monkeypatch.setattr(sys, "argv", ["briefing.py", *argv])
        briefing.main()

    def stub(self, monkeypatch, *, reachable=True):
        sent = []
        monkeypatch.setattr(briefing, "fetch_sky", lambda: SKY)
        monkeypatch.setattr(briefing, "fetch_events", lambda day: [])
        monkeypatch.setattr(briefing, "fetch_offers", lambda: "")

        def fake(text):
            sent.append(text)
            return "\n[briefing: delivered to the user \u2713]\n" if reachable else None

        monkeypatch.setattr(briefing, "deliver_to_user", fake)
        return sent

    def test_the_briefing_is_written_for_the_user(self, monkeypatch, capsys):
        sent = self.stub(monkeypatch)
        self.invoke(monkeypatch, "show")
        assert len(sent) == 1
        assert "Graz" in sent[0]
        assert "delivered to the user" in capsys.readouterr().out

    def test_quiet_sends_nothing_and_says_so(self, monkeypatch, capsys):
        sent = self.stub(monkeypatch)
        self.invoke(monkeypatch, "show", "--quiet")
        out = capsys.readouterr().out
        assert sent == []
        assert "Graz" in out
        assert "quiet - not sent to the user" in out

    def test_an_undeliverable_briefing_fails_loudly(self, monkeypatch, capsys):
        # The timer runs this with nobody watching, so a silent non-send would be worse.
        self.stub(monkeypatch, reachable=False)
        with pytest.raises(SystemExit) as exit_info:
            self.invoke(monkeypatch, "show")
        assert exit_info.value.code == 1
        assert "delivery FAILED" in capsys.readouterr().out
