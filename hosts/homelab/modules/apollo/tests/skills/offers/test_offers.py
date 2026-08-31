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


# The trades the provider files retailers under; only wholesale quotes prices net of VAT.
RETAIL = [{"id": 14, "name": "Supermarkt"}]
WHOLESALE = [{"id": 6, "name": "Großhandel"}]


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
        "industries": RETAIL,
    }
    return {**base, **over}


class FakeProvider:
    """Stands in for the offer API: `known` are the ids that exist, `found` what a watch turns up."""

    def __init__(self, known=(4517, 5693, 12747, 12769), found=(), brands=()):
        self.known = set(known)
        self.found = list(found)
        self.brands = list(brands)

    def name_of(self, kind, ident):
        return f"{kind}-{ident}" if ident in self.known else None

    def search(self, _watch, _code):
        return list(self.found)

    def survey(self, _watch, _code):
        return (self.found, {"brands": self.brands})

    def leaflet_url(self, _offer, _code):
        return None


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
    monkeypatch.setattr(offers, "WORKSPACE", tmp_path)
    monkeypatch.setattr(offers, "OFFERS_DIR", root)
    monkeypatch.setattr(offers, "CONFIG_FILE", root / "config.json")
    monkeypatch.setattr(offers, "WATCH_FILE", root / "watchlist.json")
    return root


@pytest.fixture
def wired(store, monkeypatch):
    """A configured store with the offer API stubbed out, for the commands that reach for it."""
    provider = FakeProvider()
    monkeypatch.setattr(offers, "Provider", lambda: provider)
    run("config-set", "--zip", "8010")
    return provider


class TestStore:
    def test_the_watchlist_is_in_the_workspace_not_wherever_this_ran(self):
        assert offers.OFFERS_DIR == offers.WORKSPACE / "offers"
        assert offers.WORKSPACE.is_absolute()


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


class TestIsTrade:
    def test_wholesale_is_trade(self):
        assert offers.is_trade(offer(industries=WHOLESALE)) is True

    def test_supermarket_is_not(self):
        assert offers.is_trade(offer(industries=RETAIL)) is False

    def test_an_offer_naming_no_trade_is_taken_at_face_value(self):
        assert offers.is_trade(offer(industries=[])) is False
        assert offers.is_trade({}) is False

    def test_it_is_the_trade_that_decides_never_the_name(self):
        # SPAR-Gourmet is an ordinary supermarket and Transgourmet is a wholesaler; matching
        # "gourmet" by name would mark the wrong one as net.
        spar = offer(advertisers=[{"name": "SPAR-Gourmet"}], industries=RETAIL)
        trans = offer(advertisers=[{"name": "Transgourmet"}], industries=WHOLESALE)
        assert offers.is_trade(spar) is False
        assert offers.is_trade(trans) is True


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
        assert sorted(d.price for d in deals) == [0.99, 1.29]

    def test_keeps_different_windows_apart(self):
        deals = offers.group_offers([offer(id=1), offer(id=2, validityDates=[UPCOMING])])
        assert len(deals) == 2

    def test_keeps_different_pack_sizes_apart(self):
        deals = offers.group_offers([offer(id=1, referencePrice=3.96), offer(id=2, referencePrice=2.88)])
        assert len(deals) == 2

    def test_never_merges_a_net_price_with_a_gross_one(self):
        # Same number, different meaning: one has VAT in it and the other does not.
        deals = offers.group_offers([
            offer(id=1, industries=RETAIL, advertisers=[{"name": "BILLA"}]),
            offer(id=2, industries=WHOLESALE, advertisers=[{"name": "METRO"}]),
        ])
        assert len(deals) == 2
        assert sorted(d.trade for d in deals) == [False, True]

    def test_carries_the_local_window(self):
        deal = offers.group_offers([offer(validityDates=[UPCOMING])])[0]
        assert offers.day(deal.starts) == "Thu 06.08"
        assert offers.day(deal.ends) == "Sat 08.08"

    def test_skips_offers_without_a_window_or_price(self):
        assert offers.group_offers([offer(validityDates=[])]) == []
        assert offers.group_offers([offer(price=None)]) == []

    def test_handles_no_offers(self):
        assert offers.group_offers([]) == []


class TestValueOrder:
    """Best value first, but only ever comparing like with like."""

    def sorted_refs(self, raw):
        deals = offers.group_offers(raw)
        order = offers.unit_order(deals)
        return [(d.unit, d.reference) for d in sorted(deals, key=offers.by_value(order))]

    def test_cheapest_per_unit_first_not_cheapest_sticker(self):
        # A small bottle at 2.03/l is worse value than a multipack at 0.83/l, however much less
        # it costs to pick up.
        got = self.sorted_refs([
            offer(id=1, price=0.67, referencePrice=2.03),
            offer(id=2, price=1.24, referencePrice=0.83),
        ])
        assert [ref for _u, ref in got] == [0.83, 2.03]

    def test_units_are_never_compared_against_each_other(self):
        # 0.22/Stk is not cheaper than 0.99/l - it is a different measurement. The commonest
        # unit for the watch leads, and each unit is ranked within itself.
        got = self.sorted_refs([
            offer(id=1, referencePrice=0.22, unit={"shortName": "Stk"}),
            offer(id=2, referencePrice=7.17, unit={"shortName": "kg"}),
            offer(id=3, referencePrice=9.58, unit={"shortName": "kg"}),
        ])
        assert [u for u, _r in got] == ["kg", "kg", "Stk"]
        assert [ref for _u, ref in got] == [7.17, 9.58, 0.22]

    def test_a_pinned_watch_has_one_unit_so_grouping_is_invisible(self):
        got = self.sorted_refs([
            offer(id=1, price=7.60, referencePrice=3.80),
            offer(id=2, price=0.99, referencePrice=3.96),
        ])
        assert [ref for _u, ref in got] == [3.80, 3.96]

    def test_an_unknown_per_unit_price_sorts_last(self):
        got = self.sorted_refs([
            offer(id=1, referencePrice=0, unit={}),
            offer(id=2, referencePrice=3.96),
        ])
        assert got[0][1] == 3.96

    def test_equal_value_falls_back_to_the_cheaper_sticker(self):
        got = offers.group_offers([
            offer(id=1, price=7.60, referencePrice=3.80),
            offer(id=2, price=0.95, referencePrice=3.80),
        ])
        order = offers.unit_order(got)
        assert [d.price for d in sorted(got, key=offers.by_value(order))] == [0.95, 7.60]


class TestFlags:
    def one(self, **over):
        return offers.group_offers([offer(**over)])[0]

    def test_no_flags_on_an_ordinary_price(self):
        assert offers.flags_of(self.one()) == ""

    def test_net_price_is_flagged(self):
        assert offers.NET_MARK in offers.flags_of(self.one(industries=WHOLESALE))

    def test_loyalty_price_is_flagged(self):
        assert offers.CARD_MARK in offers.flags_of(self.one(requiresLoyalityMembership=True))

    def test_both_can_apply_at_once(self):
        flags = offers.flags_of(self.one(industries=WHOLESALE, requiresLoyalityMembership=True))
        assert offers.NET_MARK in flags and offers.CARD_MARK in flags

    def test_the_two_marks_are_distinct(self):
        assert offers.NET_MARK != offers.CARD_MARK


class TestVerifyPins:
    def test_accepts_ids_that_exist(self):
        offers.verify_pins(FakeProvider(known=(4517,)), {"query": "x", "brands": [4517]})

    def test_rejects_a_brand_id_that_names_nothing(self):
        # Left in place, a typo would be indistinguishable from a product that never goes on
        # offer - which is exactly what this skill's silence is supposed to mean.
        with pytest.raises(SystemExit):
            offers.verify_pins(FakeProvider(known=(4517,)), {"query": "x", "brands": [9999]})

    def test_rejects_a_retailer_id_that_names_nothing(self):
        with pytest.raises(SystemExit):
            offers.verify_pins(FakeProvider(known=()), {"query": "x", "retailers": [1]})

    def test_a_watch_with_no_pins_needs_no_checking(self):
        offers.verify_pins(FakeProvider(known=()), {"query": "x"})


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
        assert offers.CARD_MARK not in plain
        assert offers.CARD_MARK in carded

    def test_marks_a_net_price_on_the_line(self):
        # Wholesale prices stay in the one list, flagged, rather than being split off.
        out = offers.render_watch("X", [
            offer(id=1, price=0.99, referencePrice=3.96, industries=RETAIL),
            offer(id=2, price=0.95, referencePrice=2.88, industries=WHOLESALE,
                  advertisers=[{"name": "METRO"}]),
        ], nolink, NOW)
        assert out.count(offers.NET_MARK) == 1
        metro = next(line for line in out.splitlines() if "METRO" in line)
        assert offers.NET_MARK in metro

    def test_orders_by_value_so_the_best_deal_leads(self):
        out = offers.render_watch("X", [
            offer(id=1, price=0.67, referencePrice=2.03, advertisers=[{"name": "PENNY"}]),
            offer(id=2, price=1.24, referencePrice=0.83, advertisers=[{"name": "BILLA"}]),
        ], nolink, NOW)
        assert out.index("BILLA") < out.index("PENNY")

    def test_appends_the_leaflet_link_on_its_own_line(self):
        out = offers.render_watch("X", [offer()], link, NOW)
        assert "\n    https://example.test/leaflets/78409/page/31" in out

    def test_omits_the_link_when_it_cannot_be_resolved(self):
        assert "http" not in offers.render_watch("X", [offer()], nolink, NOW)

    def test_caps_each_section_independently(self):
        many = [offer(id=i, price=1.0 + i / 100, referencePrice=1.0 + i / 100) for i in range(6)]
        many += [
            offer(id=100 + i, price=2.0 + i / 100, referencePrice=2.0 + i / 100,
                  validityDates=[UPCOMING])
            for i in range(6)
        ]
        out = offers.render_watch("X", many, nolink, NOW, cap=4)
        assert out.count("until") == 4
        assert out.count("from") == 4

    def test_the_cap_keeps_the_best_value_not_the_cheapest_sticker(self):
        deals = [offer(id=i, price=10.0 - i, referencePrice=1.0 + i) for i in range(6)]
        out = offers.render_watch("X", deals, nolink, NOW, cap=2)
        assert "(1.00/l)" in out and "(2.00/l)" in out
        assert "(6.00/l)" not in out

    def test_falls_back_when_an_offer_names_no_shop(self):
        assert "?" in offers.render_watch("X", [offer(advertisers=[])], nolink, NOW)


class TestRenderDigest:
    def test_sends_nothing_when_every_watch_is_empty(self):
        assert offers.render_digest([None, None]) is None

    def test_sends_nothing_when_there_are_no_watches(self):
        assert offers.render_digest([]) is None

    def test_heads_the_digest_with_a_title_and_no_date(self):
        # Every line states the window its price runs in, so a date here would only repeat it.
        assert offers.render_digest(["*X*\n  line"]).startswith("🏷️ Offers\n")

    def test_drops_the_empty_watches_and_keeps_the_rest(self):
        out = offers.render_digest([None, "*Red Bull*\n  a", None, "*Nutella*\n  b"])
        assert "Red Bull" in out and "Nutella" in out
        assert "None" not in out

    def test_separates_blocks_by_a_blank_line(self):
        assert "\n\n*Nutella*" in offers.render_digest(["*Red Bull*\n  a", "*Nutella*\n  b"])


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

    def test_add_defaults_the_query_to_the_label(self, wired):
        self.add()
        assert offers.load(offers.WATCH_FILE, {})["monster energy"]["query"] == "Monster Energy"

    def test_add_pins_brands_and_retailers(self, wired):
        self.add("Red Bull", "--brands", "5693", "--retailers", "12747,12769")
        watch = offers.load(offers.WATCH_FILE, {})["red bull"]
        assert watch["brands"] == [5693]
        assert watch["retailers"] == [12747, 12769]

    def test_add_takes_a_separate_query(self, wired):
        self.add("Monster", "--query", "monster energy")
        assert offers.load(offers.WATCH_FILE, {})["monster"]["query"] == "monster energy"

    def test_add_refuses_a_duplicate(self, wired):
        self.add()
        with pytest.raises(SystemExit):
            self.add()

    def test_list_reports_emptiness(self, wired, capsys):
        run("watch-list")
        assert "No watches yet" in capsys.readouterr().out

    def test_list_shows_each_watch(self, wired, capsys):
        self.add("Red Bull", "--brands", "5693")
        capsys.readouterr()
        run("watch-list")
        out = capsys.readouterr().out
        assert "1 watch(es)" in out
        assert "brands 5693" in out

    def test_edit_changes_only_what_is_passed(self, wired):
        self.add("Red Bull", "--brands", "5693")
        run("watch-edit", "--label", "red bull", "--retailers", "12769")
        watch = offers.load(offers.WATCH_FILE, {})["red bull"]
        assert watch["retailers"] == [12769]
        assert watch["brands"] == [5693]

    def test_edit_requires_a_change(self, wired):
        self.add()
        with pytest.raises(SystemExit):
            run("watch-edit", "--label", "monster energy")

    def test_edit_renames_and_rekeys(self, wired):
        self.add("Monster")
        run("watch-edit", "--label", "monster", "--rename", "Monster Energy")
        watchlist = offers.load(offers.WATCH_FILE, {})
        assert "monster energy" in watchlist
        assert "monster" not in watchlist

    def test_edit_refuses_a_rename_onto_another_watch(self, wired):
        self.add("Monster")
        self.add("Red Bull")
        with pytest.raises(SystemExit):
            run("watch-edit", "--label", "monster", "--rename", "Red Bull")

    def test_rm_removes(self, wired):
        self.add()
        run("watch-rm", "--label", "monster energy")
        assert offers.load(offers.WATCH_FILE, {}) == {}

    def test_rm_of_an_unknown_watch_fails(self, wired):
        with pytest.raises(SystemExit):
            run("watch-rm", "--label", "beer")


class TestWatchReport:
    """Setting a watch up answers where it stands, which is also how a useless watch is noticed
    at the moment it is created rather than after weeks of silence."""

    def test_says_so_when_nothing_is_on_offer(self, wired, capsys):
        run("watch-add", "--label", "Monster Energy", "--brands", "4517")
        out = capsys.readouterr().out
        assert "Now watching" in out
        assert "Nothing on offer right now" in out

    def test_shows_the_offers_when_there_are_some(self, wired, capsys):
        wired.found = [offer(advertisers=[{"name": "BILLA"}])]
        run("watch-add", "--label", "Red Bull", "--brands", "5693")
        out = capsys.readouterr().out
        assert "€0.99" in out
        assert "BILLA" in out

    def test_editing_a_watch_reports_it_too(self, wired, capsys):
        run("watch-add", "--label", "Red Bull", "--brands", "5693")
        capsys.readouterr()
        wired.found = [offer(advertisers=[{"name": "HOFER"}])]
        run("watch-edit", "--label", "red bull", "--retailers", "12747")
        out = capsys.readouterr().out
        assert "Updated" in out
        assert "HOFER" in out

    def test_warns_that_an_unpinned_watch_is_broad(self, wired):
        wired.brands = [{"id": i, "name": f"B{i}", "resultsCount": 1} for i in range(6)]
        run("watch-add", "--label", "Kaffee")
        assert any("broad" in note for note in offers.NOTES)

    def test_a_pinned_watch_is_never_called_broad(self, wired):
        wired.brands = [{"id": i, "name": f"B{i}", "resultsCount": 1} for i in range(6)]
        run("watch-add", "--label", "Monster Energy", "--brands", "4517")
        assert not any("broad" in note for note in offers.NOTES)

    def test_removing_a_watch_says_so(self, wired, capsys):
        run("watch-add", "--label", "Monster Energy", "--brands", "4517")
        capsys.readouterr()
        run("watch-rm", "--label", "monster")
        assert "Stopped watching" in capsys.readouterr().out


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
    def test_everything_describing_watches_or_offers_is_written_for_the_user(self):
        parser = offers.build_parser()
        for argv in (["digest"], ["watch-list"], ["search", "--query", "x"],
                     ["watch-add", "--label", "x"], ["watch-edit", "--label", "x", "--query", "y"],
                     ["watch-rm", "--label", "x"]):
            assert parser.parse_args(argv).delivers is True, argv

    def test_the_ids_behind_them_are_not_sent(self):
        parser = offers.build_parser()
        for argv in (["config"], ["brands", "--query", "x"], ["retailers", "--query", "x"]):
            assert parser.parse_args(argv).delivers is False, argv

    def test_the_postcode_it_is_set_to_reaches_the_user(self):
        assert offers.build_parser().parse_args(["config-set", "--zip", "1010"]).delivers is True

    def test_only_offers_in_a_shop_can_be_read_without_sending_them(self):
        parser = offers.build_parser()
        for argv in (["search", "--query", "x"], ["digest"]):
            assert parser.parse_args([*argv, "--quiet"]).quiet is True, argv

    def test_a_watch_is_the_users_so_nothing_reads_one_out_of_their_sight(self):
        parser = offers.build_parser()
        for argv in (["watch-add", "--label", "x"], ["watch-list"],
                     ["watch-edit", "--label", "x", "--query", "y"], ["watch-rm", "--label", "x"]):
            assert parser.parse_args(argv).quiet is False, argv
            with pytest.raises(SystemExit):
                parser.parse_args([*argv, "--quiet"])

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

    def test_a_delivered_watch_list_sends_and_succeeds(self, wired, monkeypatch, capsys):
        run("watch-add", "--label", "Red Bull")
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "watch-list")
        assert len(sent) == 1
        assert "Red Bull" in sent[0]
        assert "delivered to the user" in capsys.readouterr().out

    def test_a_quiet_digest_sends_nothing_and_says_so(self, wired, monkeypatch, capsys):
        run("watch-add", "--label", "Red Bull", "--brands", "5693")
        wired.found = [offer(advertisers=[{"name": "BILLA"}])]
        sent = self.spy(monkeypatch)
        capsys.readouterr()
        self.invoke(monkeypatch, "digest", "--quiet")
        out = capsys.readouterr().out
        assert sent == []
        assert "BILLA" in out
        assert "quiet - not sent to the user" in out

    def test_an_undeliverable_send_fails_loudly(self, wired, monkeypatch, capsys):
        run("watch-add", "--label", "Red Bull")
        self.spy(monkeypatch, reachable=False)
        with pytest.raises(SystemExit) as exit_info:
            self.invoke(monkeypatch, "watch-list")
        assert exit_info.value.code == 1
        assert "delivery FAILED" in capsys.readouterr().out

    def test_machinery_never_sends_and_still_succeeds(self, wired, monkeypatch, capsys):
        sent = self.spy(monkeypatch, reachable=False)
        self.invoke(monkeypatch, "config")
        out = capsys.readouterr().out
        assert sent == []
        assert "8010" in out
        assert "FAILED" not in out

    def test_a_digest_with_nothing_to_say_sends_nothing_and_succeeds(self, wired, monkeypatch, capsys):
        sent = self.spy(monkeypatch, reachable=False)
        run("config-set", "--zip", "4020")
        capsys.readouterr()
        self.invoke(monkeypatch, "digest")  # no watches, so it never reaches the network
        assert sent == []
        assert "nothing is being watched" in capsys.readouterr().out
