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
    def test_one_day_ends_on_the_next_one(self):
        # proton-cli's --end is exclusive: start == end returns nothing, which would look like a
        # free day every single morning.
        assert briefing.calendar_window(DAY) == ("2026-08-03", "2026-08-04")

    def test_it_never_asks_for_a_zero_length_range(self):
        start, end = briefing.calendar_window(DAY)
        assert start != end


class TestEventWhen:
    def test_a_timed_event_shows_its_span(self):
        assert briefing.event_when(event(), DAY) == "19:00-22:00"

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
