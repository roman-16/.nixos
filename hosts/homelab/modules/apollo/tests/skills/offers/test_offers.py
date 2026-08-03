import argparse
import sys
from datetime import datetime

import offers
import pytest

# A Monday, mid-morning: the fixtures below straddle it so "running" and "upcoming" are both real.
NOW = datetime(2026, 8, 3, 9, 0, tzinfo=offers.TZ)

# Local Thu 30.07 00:00 -> Wed 05.08 23:59, i.e. running as of NOW.
RUNNING = {"from": "2026-07-29T22:00:00Z", "to": "2026-08-05T21:59:00Z"}
# Local Thu 06.08 00:00 -> Sat 08.08 23:59, i.e. not started yet.
UPCOMING = {"from": "2026-08-05T22:00:00Z", "to": "2026-08-08T21:59:00Z"}


def offer(**over):
    base = {
        "id": 1,
        "price": 0.99,
        "referencePrice": 3.96,
        "unit": {"shortName": "l"},
        "advertisers": [{"name": "BILLA"}],
        "validityDates": [RUNNING],
        "requiresLoyalityMembership": False,
        "leafletFlightId": 43822,
    }
    return {**base, **over}


def nolink(_offer):
    return None


def link(_offer):
    return "https://example.test/leaflets/78409/page/31"


def run(*argv):
    args = offers.build_parser().parse_args(list(argv))
    args.func(args)


@pytest.fixture
def store(tmp_path, monkeypatch):
    offers.NOTES.clear()
    root = tmp_path / "offers"
    monkeypatch.setattr(offers, "OFFERS_DIR", root)
    monkeypatch.setattr(offers, "CONFIG_FILE", root / "config.json")
    monkeypatch.setattr(offers, "WATCH_FILE", root / "watchlist.json")
    return root


class TestLocal:
    def test_window_start_belongs_to_the_next_local_day(self):
        # The provider stores UTC; 22:00Z in summer is midnight here. Slicing the date off the
        # string would report this deal as starting on the 5th, a day before it does.
        assert offers.local("2026-08-05T22:00:00Z").date().isoformat() == "2026-08-06"

    def test_window_end_stays_on_its_own_day(self):
        assert offers.local("2026-08-08T21:59:00Z").date().isoformat() == "2026-08-08"

    def test_start_also_rolls_over_in_winter(self):
        # CET is UTC+1, so local midnight is 23:00Z the day before.
        assert offers.local("2026-01-14T23:00:00Z").date().isoformat() == "2026-01-15"

    def test_keeps_the_local_wall_clock(self):
        assert offers.local("2026-08-05T22:00:00Z").strftime("%H:%M") == "00:00"


class TestDay:
    def test_weekday_plus_day_and_month(self):
        assert offers.day(offers.local("2026-08-05T22:00:00Z")) == "Thu 06.08"

    def test_pads_single_digits(self):
        assert offers.day(datetime(2026, 3, 7, 12, tzinfo=offers.TZ)) == "Sat 07.03"


class TestMoney:
    def test_two_decimals(self):
        assert offers.money(0.9) == "0.90"
        assert offers.money(7.6) == "7.60"


class TestGroupOffers:
    def test_collapses_the_same_deal_across_shops(self):
        deals = offers.group_offers([
            offer(id=1, advertisers=[{"name": "BILLA"}]),
            offer(id=2, advertisers=[{"name": "BILLA PLUS"}]),
        ])
        assert len(deals) == 1
        assert offers.shops_of(deals[0].offers) == ["BILLA", "BILLA PLUS"]

    def test_keeps_different_prices_apart(self):
        deals = offers.group_offers([offer(id=1, price=0.99), offer(id=2, price=1.29)])
        assert [d.price for d in deals] == [0.99, 1.29]

    def test_keeps_different_windows_apart(self):
        deals = offers.group_offers([offer(id=1), offer(id=2, validityDates=[UPCOMING])])
        assert len(deals) == 2

    def test_keeps_different_pack_sizes_apart(self):
        deals = offers.group_offers([offer(id=1, referencePrice=3.96), offer(id=2, referencePrice=2.88)])
        assert len(deals) == 2

    def test_sorts_cheapest_first(self):
        deals = offers.group_offers([offer(id=1, price=7.6), offer(id=2, price=0.95)])
        assert [d.price for d in deals] == [0.95, 7.6]

    def test_carries_the_local_window(self):
        deal = offers.group_offers([offer(validityDates=[UPCOMING])])[0]
        assert offers.day(deal.starts) == "Thu 06.08"
        assert offers.day(deal.ends) == "Sat 08.08"

    def test_skips_offers_without_a_window_or_price(self):
        assert offers.group_offers([offer(validityDates=[])]) == []
        assert offers.group_offers([offer(price=None)]) == []

    def test_handles_no_offers(self):
        assert offers.group_offers([]) == []


class TestRenderWatch:
    def test_omits_a_watch_with_nothing_on_offer(self):
        assert offers.render_watch("Monster Energy", [], nolink, NOW) is None

    def test_omits_a_watch_whose_offers_are_all_unusable(self):
        assert offers.render_watch("Monster Energy", [offer(validityDates=[])], nolink, NOW) is None

    def test_labels_a_running_deal_by_its_end(self):
        out = offers.render_watch("Red Bull", [offer()], nolink, NOW)
        assert "*Red Bull*" in out
        assert "until Wed 05.08" in out
        assert "upcoming" not in out

    def test_labels_an_upcoming_deal_by_its_start(self):
        out = offers.render_watch("Red Bull", [offer(validityDates=[UPCOMING])], nolink, NOW)
        assert "_upcoming:_" in out
        assert "from Thu 06.08" in out

    def test_splits_running_from_upcoming(self):
        out = offers.render_watch(
            "Red Bull", [offer(id=1), offer(id=2, price=0.95, validityDates=[UPCOMING])], nolink, NOW
        )
        assert out.index("until Wed 05.08") < out.index("_upcoming:_") < out.index("from Thu 06.08")

    def test_shows_price_shops_and_reference_price(self):
        out = offers.render_watch("Red Bull", [offer()], nolink, NOW)
        assert "€0.99" in out
        assert "(3.96/l)" in out
        assert "BILLA" in out

    def test_omits_the_reference_price_when_there_is_no_unit(self):
        out = offers.render_watch("X", [offer(referencePrice=0, unit={})], nolink, NOW)
        assert "/" not in out.split("·")[0]

    def test_marks_a_loyalty_price(self):
        plain = offers.render_watch("X", [offer()], nolink, NOW)
        carded = offers.render_watch("X", [offer(requiresLoyalityMembership=True)], nolink, NOW)
        assert "💳" not in plain
        assert "💳" in carded

    def test_appends_the_leaflet_link_on_its_own_line(self):
        out = offers.render_watch("X", [offer()], link, NOW)
        assert "\n    https://example.test/leaflets/78409/page/31" in out

    def test_omits_the_link_when_it_cannot_be_resolved(self):
        assert "http" not in offers.render_watch("X", [offer()], nolink, NOW)

    def test_caps_each_section_independently(self):
        many = [offer(id=i, price=1.0 + i / 100) for i in range(6)]
        many += [offer(id=100 + i, price=2.0 + i / 100, validityDates=[UPCOMING]) for i in range(6)]
        out = offers.render_watch("X", many, nolink, NOW, cap=4)
        assert out.count("until") == 4
        assert out.count("from") == 4

    def test_falls_back_when_an_offer_names_no_shop(self):
        assert "?" in offers.render_watch("X", [offer(advertisers=[])], nolink, NOW)


class TestRenderDigest:
    def test_sends_nothing_when_every_watch_is_empty(self):
        assert offers.render_digest([None, None], NOW) is None

    def test_sends_nothing_when_there_are_no_watches(self):
        assert offers.render_digest([], NOW) is None

    def test_heads_the_digest_with_the_day(self):
        assert offers.render_digest(["*X*\n  line"], NOW).startswith("🏷️ Offers Mon 03.08")

    def test_drops_the_empty_watches_and_keeps_the_rest(self):
        out = offers.render_digest([None, "*Red Bull*\n  a", None, "*Nutella*\n  b"], NOW)
        assert "Red Bull" in out and "Nutella" in out
        assert "None" not in out

    def test_separates_blocks_by_a_blank_line(self):
        assert "\n\n*Nutella*" in offers.render_digest(["*Red Bull*\n  a", "*Nutella*\n  b"], NOW)


class TestIdList:
    def test_parses_commas_and_spaces(self):
        assert offers.id_list("12747,12769") == [12747, 12769]
        assert offers.id_list("12747 12769") == [12747, 12769]

    def test_empty_is_no_ids(self):
        assert offers.id_list("") == []
        assert offers.id_list(None) == []

    def test_rejects_a_non_id(self):
        with pytest.raises(argparse.ArgumentTypeError):
            offers.id_list("hofer")


class TestConfig:
    def test_reports_an_unset_postcode(self, store, capsys):
        run("config")
        assert "not set" in capsys.readouterr().out

    def test_set_then_read_back(self, store, capsys):
        run("config-set", "--zip", "4020")
        capsys.readouterr()
        run("config")
        assert "Postcode: 4020" in capsys.readouterr().out

    def test_postcode_persists_so_it_is_asked_only_once(self, store):
        run("config-set", "--zip", "4020")
        assert offers.zip_code() == "4020"

    def test_rejects_a_non_numeric_postcode(self, store):
        with pytest.raises(SystemExit):
            run("config-set", "--zip", "Linz")

    def test_dies_helpfully_when_no_postcode_is_set(self, store):
        with pytest.raises(SystemExit):
            offers.zip_code()


class TestWatches:
    def add(self, label="Monster Energy", *extra):
        run("watch-add", "--label", label, *extra)

    def test_add_defaults_the_query_to_the_label(self, store):
        self.add()
        assert offers.load(offers.WATCH_FILE, {})["monster energy"]["query"] == "Monster Energy"

    def test_add_pins_brands_and_retailers(self, store):
        self.add("Red Bull", "--brands", "5693", "--retailers", "12747,12769")
        watch = offers.load(offers.WATCH_FILE, {})["red bull"]
        assert watch["brands"] == [5693]
        assert watch["retailers"] == [12747, 12769]

    def test_add_takes_a_separate_query(self, store):
        self.add("Monster", "--query", "monster energy")
        assert offers.load(offers.WATCH_FILE, {})["monster"]["query"] == "monster energy"

    def test_add_refuses_a_duplicate(self, store):
        self.add()
        with pytest.raises(SystemExit):
            self.add()

    def test_list_reports_emptiness(self, store, capsys):
        run("watch-list")
        assert "No watches yet" in capsys.readouterr().out

    def test_list_shows_each_watch(self, store, capsys):
        self.add("Red Bull", "--brands", "5693")
        capsys.readouterr()
        run("watch-list")
        out = capsys.readouterr().out
        assert "1 watch(es)" in out
        assert "brands 5693" in out

    def test_edit_changes_only_what_is_passed(self, store):
        self.add("Red Bull", "--brands", "5693")
        run("watch-edit", "--label", "red bull", "--retailers", "12769")
        watch = offers.load(offers.WATCH_FILE, {})["red bull"]
        assert watch["retailers"] == [12769]
        assert watch["brands"] == [5693]

    def test_edit_requires_a_change(self, store):
        self.add()
        with pytest.raises(SystemExit):
            run("watch-edit", "--label", "monster energy")

    def test_edit_renames_and_rekeys(self, store):
        self.add("Monster")
        run("watch-edit", "--label", "monster", "--rename", "Monster Energy")
        watchlist = offers.load(offers.WATCH_FILE, {})
        assert "monster energy" in watchlist
        assert "monster" not in watchlist

    def test_edit_refuses_a_rename_onto_another_watch(self, store):
        self.add("Monster")
        self.add("Red Bull")
        with pytest.raises(SystemExit):
            run("watch-edit", "--label", "monster", "--rename", "Red Bull")

    def test_rm_removes(self, store):
        self.add()
        run("watch-rm", "--label", "monster energy")
        assert offers.load(offers.WATCH_FILE, {}) == {}

    def test_rm_of_an_unknown_watch_fails(self, store):
        with pytest.raises(SystemExit):
            run("watch-rm", "--label", "beer")


class TestFindWatch:
    def watchlist(self):
        return {
            "monster energy": {"label": "Monster Energy"},
            "red bull": {"label": "Red Bull"},
            "red wine": {"label": "Red Wine"},
        }

    def test_exact_key(self):
        key, _, assumed = offers.find_watch(self.watchlist(), "monster energy")
        assert key == "monster energy"
        assert assumed is None

    def test_case_insensitive(self):
        assert offers.find_watch(self.watchlist(), "MONSTER ENERGY")[0] == "monster energy"

    def test_unique_substring(self):
        assert offers.find_watch(self.watchlist(), "monster")[0] == "monster energy"

    def test_ambiguous_substring_refuses_to_guess(self):
        with pytest.raises(SystemExit):
            offers.find_watch(self.watchlist(), "red")

    def test_lone_typo_is_accepted_and_announced(self):
        key, _, assumed = offers.find_watch(self.watchlist(), "montser energy")
        assert key == "monster energy"
        assert assumed == "Monster Energy"

    def test_miss_fails(self):
        with pytest.raises(SystemExit):
            offers.find_watch(self.watchlist(), "bicycle")

    def test_blank_fails(self):
        with pytest.raises(SystemExit):
            offers.find_watch(self.watchlist(), "   ")


class TestWatchLine:
    def test_shows_the_query(self):
        line = offers.watch_line({"label": "Monster", "query": "monster energy"})
        assert "Monster" in line and 'query "monster energy"' in line

    def test_shows_pinned_ids_when_present(self):
        line = offers.watch_line(
            {"label": "X", "query": "x", "brands": [4517], "retailers": [12747, 12769]}
        )
        assert "brands 4517" in line
        assert "retailers 12747,12769" in line

    def test_omits_empty_pins(self):
        line = offers.watch_line({"label": "X", "query": "x", "brands": [], "retailers": []})
        assert "brands" not in line and "retailers" not in line


class TestAudience:
    def test_the_digest_and_searches_are_written_for_the_user(self):
        parser = offers.build_parser()
        for name in ("digest", "watch-list"):
            assert parser.parse_args([name]).delivers is True
        assert parser.parse_args(["search", "--query", "x"]).delivers is True

    def test_machinery_and_mutations_are_not_sent(self):
        parser = offers.build_parser()
        for argv in (["config"], ["config-set", "--zip", "1010"], ["brands", "--query", "x"],
                     ["retailers", "--query", "x"], ["watch-add", "--label", "x"],
                     ["watch-rm", "--label", "x"]):
            assert parser.parse_args(argv).delivers is False, argv

    def test_every_command_accepts_quiet(self):
        parser = offers.build_parser()
        for argv in (["config"], ["config-set", "--zip", "1010"], ["brands", "--query", "x"],
                     ["retailers", "--query", "x"], ["watch-add", "--label", "x"],
                     ["watch-list"], ["watch-edit", "--label", "x", "--query", "y"],
                     ["watch-rm", "--label", "x"], ["search", "--query", "x"], ["digest"]):
            assert hasattr(parser.parse_args([*argv, "--quiet"]), "quiet"), argv

    def test_search_needs_a_query_or_a_watch(self):
        with pytest.raises(SystemExit):
            offers.build_parser().parse_args(["search"])

    def test_search_takes_a_query_or_a_watch_but_not_both(self):
        with pytest.raises(SystemExit):
            offers.build_parser().parse_args(["search", "--query", "x", "--watch", "y"])


class TestDelivery:
    """main()'s exit code, which is the only thing the unattended 09:00 run can be judged by."""

    def invoke(self, monkeypatch, *argv):
        monkeypatch.setattr(sys, "argv", ["offers.py", *argv])
        offers.main()

    def spy(self, monkeypatch, *, reachable=True):
        sent = []

        def fake(text):
            sent.append(text)
            return "\n[offers: delivered to the user \u2713]\n" if reachable else None

        monkeypatch.setattr(offers, "deliver_to_user", fake)
        return sent

    def test_a_delivered_watch_list_sends_and_succeeds(self, store, monkeypatch, capsys):
        run("watch-add", "--label", "Red Bull")
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "watch-list")
        assert len(sent) == 1
        assert "Red Bull" in sent[0]
        assert "delivered to the user" in capsys.readouterr().out

    def test_quiet_sends_nothing_and_says_so(self, store, monkeypatch, capsys):
        run("watch-add", "--label", "Red Bull")
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "watch-list", "--quiet")
        out = capsys.readouterr().out
        assert sent == []
        assert "Red Bull" in out
        assert "quiet - not sent to the user" in out

    def test_an_undeliverable_send_fails_loudly(self, store, monkeypatch, capsys):
        run("watch-add", "--label", "Red Bull")
        self.spy(monkeypatch, reachable=False)
        with pytest.raises(SystemExit) as exit_info:
            self.invoke(monkeypatch, "watch-list")
        assert exit_info.value.code == 1
        assert "delivery FAILED" in capsys.readouterr().out

    def test_machinery_never_sends_and_still_succeeds(self, store, monkeypatch, capsys):
        sent = self.spy(monkeypatch, reachable=False)
        self.invoke(monkeypatch, "config-set", "--zip", "4020")
        out = capsys.readouterr().out
        assert sent == []
        assert "4020" in out
        assert "FAILED" not in out

    def test_a_digest_with_nothing_to_say_sends_nothing_and_succeeds(self, store, monkeypatch, capsys):
        sent = self.spy(monkeypatch, reachable=False)
        run("config-set", "--zip", "4020")
        capsys.readouterr()
        self.invoke(monkeypatch, "digest")  # no watches, so it never reaches the network
        assert sent == []
        assert "nothing is being watched" in capsys.readouterr().out
