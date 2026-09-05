import argparse
import io
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta

import macros
import pytest

CATALOG = {
    "skyr, plain": {"name": "Skyr, plain", "aliases": ["skyr", "my skyr", "skyr, plain"]},
    "sportyfeel protein bar": {
        "name": "SportyFeel Protein Bar",
        "aliases": ["sportyfeel bar", "sportyfeel protein bar"],
    },
    "whey protein": {"name": "Whey Protein", "aliases": ["whey", "whey protein"]},
}


def run(*argv):
    args = macros.build_parser().parse_args(list(argv))
    args.func(args)


@pytest.fixture
def store(tmp_path, monkeypatch):
    macros.NOTES.clear()
    root = tmp_path / "macros"
    monkeypatch.setattr(macros, "WORKSPACE", tmp_path)
    monkeypatch.setattr(macros, "MACROS_DIR", root)
    monkeypatch.setattr(macros, "DAYS_DIR", root / "days")
    monkeypatch.setattr(macros, "GOAL_FILE", root / "goal.json")
    monkeypatch.setattr(macros, "FOOD_FILE", root / "food.json")
    monkeypatch.setattr(macros, "PREP_FILE", root / "prep.json")
    return root


def set_goal():
    run("goal-set", "--phase", "cut", "--tdee", "2400", "--daily-goal", "2100", "--protein", "150")


def add_skyr():
    run("food-add", "--name", "Skyr, plain", "--kcal100", "64", "--protein100", "11",
        "--fat100", "0.1", "--carbs100", "4", "--serving", "500", "--aliases", "skyr,my skyr",
        "--asked", "--exact")


def add_bolognese():
    run("prep-add", "--name", "Bolognese")
    run("prep-ingredient-add", "--name", "bolognese", "--label", "Beef", "--kcal", "1000",
        "--protein", "100", "--fat", "60", "--carbs", "0", "--exact")
    run("prep-ingredient-add", "--name", "bolognese", "--label", "Passata", "--kcal", "800",
        "--protein", "20", "--fat", "30", "--carbs", "110", "--exact")


def day_entries():
    path = macros.day_path(macros.today())
    return macros.load(path, {}).get("entries", []) if path.exists() else []


def days_ago(n: int) -> str:
    return (datetime.strptime(macros.today(), "%Y-%m-%d") - timedelta(days=n)).strftime("%Y-%m-%d")


def preps():
    return macros.load(macros.PREP_FILE, {})


def named(name):
    return [b for b in preps().values() if b["name"].lower() == name.lower()]


def one_named(name):
    matches = named(name)
    assert len(matches) == 1, f"expected one prep named {name!r}, found {len(matches)}"
    return matches[0]


def live_named(name):
    return [b for b in named(name) if b.get("archivedAt") is None]


def archived_named(name):
    return [b for b in named(name) if b.get("archivedAt") is not None]


class TestMacroDate:
    def test_before_4am_counts_as_previous_day(self):
        assert macros.macro_date(datetime(2026, 7, 19, 2, 0)) == "2026-07-18"

    def test_at_4am_is_the_new_day(self):
        assert macros.macro_date(datetime(2026, 7, 19, 4, 0)) == "2026-07-19"

    def test_after_4am_is_same_day(self):
        assert macros.macro_date(datetime(2026, 7, 19, 6, 0)) == "2026-07-19"

    def test_late_evening_stays_that_day(self):
        assert macros.macro_date(datetime(2026, 7, 19, 23, 30)) == "2026-07-19"


class TestNumify:
    def test_strips_thousands_separator(self):
        assert macros.numify("1,000") == 1000

    def test_keeps_whole_numbers_as_int(self):
        assert isinstance(macros.numify("3.0"), int)

    def test_keeps_fractions_as_float(self):
        assert macros.numify("2.5") == 2.5


class TestQuantities:
    """What a number means is settled at the door, because this store keeps a ledger: a fraction
    logged once is folded into every later day's cumulative and target, where no amount of rounding
    at the print site can reach it again."""

    def test_kcal_are_whole(self):
        assert macros.WHOLE("257.4") == 257
        assert macros.WHOLE("257") == 257
        assert macros.WHOLE_POSITIVE("2400.5") == 2400

    def test_no_calories_is_a_real_figure_but_not_a_real_goal(self):
        assert macros.WHOLE("0") == 0  # black coffee
        with pytest.raises(argparse.ArgumentTypeError):
            macros.WHOLE_POSITIVE("0")

    def test_a_negative_is_refused_before_it_can_round_away(self):
        # -0.4 must not arrive as a harmless-looking 0: a slip errors out rather than quietly
        # costing a total.
        for slip in ("-1", "-0.4"):
            with pytest.raises(argparse.ArgumentTypeError):
                macros.WHOLE(slip)
        with pytest.raises(argparse.ArgumentTypeError):
            macros.TENTH("-0.04")

    def test_grams_keep_one_decimal(self):
        assert macros.TENTH("11.55") == 11.6
        assert macros.TENTH("0") == 0
        assert macros.TENTH_POSITIVE("66.42") == 66.4

    def test_an_amount_is_kept_as_it_reads(self):
        assert macros.AMOUNT("0.5") == 0.5
        assert macros.AMOUNT("9.94") == 9.9
        assert macros.AMOUNT("234.6") == 235

    def test_an_amount_that_rounds_away_to_nothing_is_refused(self):
        with pytest.raises(argparse.ArgumentTypeError):
            macros.AMOUNT("0.04")

    def test_a_label_written_with_a_thousands_separator_still_reads(self):
        assert macros.WHOLE("1,000") == 1000


class TestFlagUnits:
    """A flag's name says what it measures, so its type has to agree - which is what stops a flag
    added later from quietly reopening the door the ledger's fraction came through."""

    UNITS = {
        "--amount": {"AMOUNT"},
        "--carbs": {"TENTH"},
        "--carbs100": {"TENTH"},
        "--daily-goal": {"WHOLE_POSITIVE"},
        "--fat": {"TENTH"},
        "--fat100": {"TENTH"},
        "--kcal": {"WHOLE"},
        "--kcal100": {"WHOLE"},
        "--kg": {"TENTH_POSITIVE"},
        "--protein": {"TENTH", "TENTH_POSITIVE"},  # a logged gram figure, and the daily goal
        "--protein100": {"TENTH"},
        "--serving": {"AMOUNT"},
        "--servings": {"AMOUNT"},
        "--size": {"AMOUNT"},
        "--target-kcal": {"WHOLE_POSITIVE"},
        "--target-protein": {"TENTH_POSITIVE"},
        "--tdee": {"WHOLE_POSITIVE"},
        "--weight-goal": {"TENTH_POSITIVE"},
    }

    # Counting flags means walking the parser, which argparse only exposes privately.
    def commands(self):
        parser = macros.build_parser()
        sub = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
        for name, command in sub.choices.items():
            for action in command._actions:
                for flag in action.option_strings:
                    yield name, flag, action.type

    def quantities(self) -> dict:
        return {getattr(macros, name): name
                for name in ("AMOUNT", "TENTH", "TENTH_POSITIVE", "WHOLE", "WHOLE_POSITIVE")}

    def measured(self):
        quantities = self.quantities()
        return [(command, flag, quantities[kind])
                for command, flag, kind in self.commands() if kind in quantities]

    def test_there_are_measured_flags_to_check(self):
        assert len(self.measured()) > 30

    def test_every_measured_flag_parses_the_quantity_its_name_names(self):
        wrong = [f"{command} {flag} is {quantity}"
                 for command, flag, quantity in self.measured()
                 if quantity not in self.UNITS.get(flag, set())]
        assert wrong == []

    def test_nothing_measured_is_parsed_as_a_bare_number(self):
        # int is for indexes and day counts; anything measured names its quantity instead.
        loose = [f"{command} {flag}" for command, flag, kind in self.commands()
                 if kind is float or (kind is int and flag not in ("--index", "--days"))]
        assert loose == []


class TestParseFraction:
    def test_slash(self):
        assert macros.parse_fraction("1/5") == 0.2

    def test_percent(self):
        assert macros.parse_fraction("20%") == 0.2

    def test_decimal(self):
        assert macros.parse_fraction("0.2") == 0.2


class TestLabelsOf:
    def test_lowercased_union_of_key_name_aliases(self):
        labels = macros.labels_of("Key", {"name": "Name", "aliases": ["A", "b"]})
        assert labels == {"key", "name", "a", "b"}


class TestFind:
    def test_exact_by_alias(self):
        match = macros.find(CATALOG, "skyr")
        assert match.kind == "exact"
        assert match.key == "skyr, plain"

    def test_exact_by_name_case_insensitive(self):
        assert macros.find(CATALOG, "Skyr, Plain").kind == "exact"

    def test_unique_substring(self):
        match = macros.find(CATALOG, "sportyfeel")
        assert match.kind == "substring"
        assert match.value["name"] == "SportyFeel Protein Bar"

    def test_ambiguous_substring_lists_candidates_without_picking(self):
        match = macros.find(CATALOG, "protein")
        assert match.kind == "ambiguous"
        assert match.value is None
        assert set(match.candidates) == {"SportyFeel Protein Bar", "Whey Protein"}

    def test_fuzzy_last_resort_on_typo(self):
        match = macros.find(CATALOG, "skyer")
        assert match.kind == "fuzzy"
        assert match.value["name"] == "Skyr, plain"
        assert match.candidates == ["Skyr, plain"]

    def test_none_for_no_match(self):
        assert macros.find(CATALOG, "pizza").kind == "none"

    def test_none_for_blank_query(self):
        assert macros.find(CATALOG, "   ").kind == "none"


class TestFoodCatalog:
    def test_add_then_get_by_substring(self, store, capsys):
        add_skyr()
        capsys.readouterr()
        run("food-get", "skyr")
        assert "Skyr, plain" in capsys.readouterr().out

    def test_edit_updates_value_and_renames(self, store):
        run("food-add", "--name", "Whey", "--kcal100", "375", "--protein100", "80",
            "--fat100", "5", "--carbs100", "8", "--serving", "30", "--asked", "--exact")
        run("food-edit", "--name", "whey", "--kcal100", "380", "--rename", "Whey Isolate")
        food = macros.load(macros.FOOD_FILE, {})
        assert "whey isolate" in food
        assert food["whey isolate"]["per100"]["kcal"] == 380
        assert food["whey isolate"]["name"] == "Whey Isolate"

    def test_rm_by_exact_name_removes(self, store):
        add_skyr()
        run("food-rm", "--name", "skyr")
        assert macros.load(macros.FOOD_FILE, {}) == {}

    def test_rm_refuses_a_fuzzy_match_and_keeps_the_food(self, store):
        add_skyr()
        with pytest.raises(SystemExit):
            run("food-rm", "--name", "skye")
        assert "skyr, plain" in macros.load(macros.FOOD_FILE, {})


class TestFoodEat:
    def test_announces_a_fuzzy_assumption(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-eat", "--name", "skyer", "--amount", "100")
        assert 'read "skyer" as Skyr, plain' in capsys.readouterr().out

    def test_exact_match_makes_no_assumption(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-eat", "--name", "skyr", "--amount", "100")
        assert "read" not in capsys.readouterr().out


class TestFoodUnits:
    def add_beer(self):
        run("food-add", "--name", "Gösser", "--unit", "ml", "--kcal100", "42",
            "--protein100", "0.5", "--fat100", "0", "--carbs100", "3.3", "--serving", "500",
            "--asked", "--exact")

    def test_add_stores_the_unit(self, store):
        self.add_beer()
        assert macros.load(macros.FOOD_FILE, {})["gösser"]["unit"] == "ml"

    def test_unit_defaults_to_grams(self, store):
        add_skyr()
        assert macros.load(macros.FOOD_FILE, {})["skyr, plain"]["unit"] == "g"

    def test_food_line_shows_the_unit(self, store, capsys):
        self.add_beer()
        capsys.readouterr()
        run("food-get", "gösser")
        out = capsys.readouterr().out
        assert "per 100ml" in out
        assert "default serving 500ml" in out

    def test_eat_logs_in_the_unit(self, store):
        set_goal()
        self.add_beer()
        run("food-eat", "--name", "gösser", "--amount", "500")
        assert "Gösser (500ml)" in day_entries()[-1]["item"]

    def test_default_serving_uses_the_unit(self, store):
        set_goal()
        self.add_beer()
        run("food-eat", "--name", "gösser")
        assert "Gösser (500ml)" in day_entries()[-1]["item"]

    def test_edit_changes_the_unit(self, store):
        add_skyr()
        run("food-edit", "--name", "skyr", "--unit", "ml")
        assert macros.load(macros.FOOD_FILE, {})["skyr, plain"]["unit"] == "ml"

    def test_legacy_food_without_unit_eats_as_grams(self, store):
        set_goal()
        add_skyr()
        food = macros.load(macros.FOOD_FILE, {})
        del food["skyr, plain"]["unit"]
        macros.save(macros.FOOD_FILE, food)
        run("food-eat", "--name", "skyr", "--amount", "200")
        assert "Skyr, plain (200g)" in day_entries()[-1]["item"]

    def test_target_reports_the_unit(self, store, capsys):
        set_goal()
        self.add_beer()
        capsys.readouterr()
        run("food-eat", "--name", "gösser", "--target-kcal", "210", "--dry-run")
        assert "500ml" in capsys.readouterr().out


class TestEat:
    def test_scales_per100_by_amount(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "200", "--exact")
        entry = day_entries()[-1]
        assert entry["item"] == "Granola (200g)"
        assert entry["kcal"] == 900
        assert entry["protein"] == 20
        assert entry["fat"] == 40
        assert entry["carbs"] == 110

    def test_unit_defaults_to_grams(self, store):
        set_goal()
        run("eat", "--item", "Rice", "--kcal100", "130", "--amount", "150", "--exact")
        assert "Rice (150g)" in day_entries()[-1]["item"]

    def test_ml_unit_labels_the_amount(self, store):
        set_goal()
        run("eat", "--item", "Oat drink", "--unit", "ml", "--kcal100", "46",
            "--protein100", "1", "--amount", "500", "--exact")
        assert "Oat drink (500ml)" in day_entries()[-1]["item"]

    def test_other_macros_default_to_zero(self, store):
        set_goal()
        run("eat", "--item", "Sugar", "--kcal100", "400", "--amount", "50", "--exact")
        entry = day_entries()[-1]
        assert entry["kcal"] == 200
        assert entry["protein"] == 0
        assert entry["fat"] == 0
        assert entry["carbs"] == 0

    def test_kcal100_is_required(self, store):
        with pytest.raises(SystemExit):
            run("eat", "--item", "Mystery", "--amount", "100", "--exact")

    def test_amount_or_target_required(self, store):
        with pytest.raises(SystemExit):
            run("eat", "--item", "Granola", "--kcal100", "450", "--exact")

    def test_note_passthrough(self, store):
        set_goal()
        run("eat", "--item", "Chips", "--kcal100", "536", "--amount", "60", "--note", "shared",
            "--exact")
        assert day_entries()[-1]["note"] == "shared"

    def test_dry_run_saves_nothing(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("eat", "--item", "Granola", "--kcal100", "450", "--amount", "200", "--dry-run", "--exact")
        assert "preview" in capsys.readouterr().out
        assert day_entries() == []

    def test_fit_protein_sizes_and_logs(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("eat", "--item", "Whey", "--kcal100", "375", "--protein100", "80", "--fit-protein", "--exact")
        assert "to reach your protein goal" in capsys.readouterr().out
        assert day_entries()[-1]["protein"] >= 149


class TestMacroHelpers:
    def test_add(self):
        assert macros.macro_add(
            {"kcal": 1, "protein": 2, "fat": 3, "carbs": 4},
            {"kcal": 10, "protein": 20, "fat": 30, "carbs": 40},
        ) == {"kcal": 11, "protein": 22, "fat": 33, "carbs": 44}

    def test_scale(self):
        assert macros.macro_scale({"kcal": 100, "protein": 10, "fat": 4, "carbs": 20}, 0.5) == {
            "kcal": 50.0, "protein": 5.0, "fat": 2.0, "carbs": 10.0,
        }

    def test_total_sums_ingredients_ignoring_label(self):
        batch = {
            "ingredients": [
                {"label": "a", "kcal": 100, "protein": 10, "fat": 5, "carbs": 20},
                {"label": "b", "kcal": 200, "protein": 20, "fat": 10, "carbs": 30},
            ],
            "consumption": [],
        }
        assert macros.prep_total(batch) == {"kcal": 300, "protein": 30, "fat": 15, "carbs": 50}

    def test_frac_left_of_empty_is_zero(self):
        assert macros.frac_left({"ingredients": [], "consumption": []}) == 0.0

    def test_consumed_derives_totals_and_fractions_by_kind(self):
        batch = {
            "ingredients": [{"label": "x", "kcal": 1000, "protein": 100, "fat": 0, "carbs": 0}],
            "consumption": [
                {"id": "1", "kind": "eaten", "date": "2026-07-15", "time": "20:00",
                 "macros": {"kcal": 300, "protein": 30, "fat": 0, "carbs": 0}, "label": "a"},
                {"id": "2", "kind": "removed", "date": "2026-07-15", "time": "21:00",
                 "macros": {"kcal": 200, "protein": 20, "fat": 0, "carbs": 0}, "label": "b"},
            ],
        }
        assert macros.consumed(batch, "eaten")["kcal"] == 300
        assert macros.consumed(batch, "removed")["kcal"] == 200
        assert macros.prep_remaining(batch)["kcal"] == 500
        assert macros.frac_eaten(batch) == pytest.approx(0.3)
        assert macros.frac_left(batch) == pytest.approx(0.5)


class TestIngredientSources:
    """An ingredient's numbers arrive three ways, and the two with a rate behind them are scaled
    here rather than multiplied out by the caller."""

    def notes(self):
        return "\n".join(macros.NOTES)

    def test_a_saved_food_is_scaled_by_the_amount(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400")
        ingredient = one_named("bolognese")["ingredients"][0]
        assert ingredient["kcal"] == 256
        assert ingredient["protein"] == 44

    def test_the_label_writes_itself_from_the_food_and_the_amount(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400")
        assert one_named("bolognese")["ingredients"][0]["label"] == "Skyr, plain (400g)"

    def test_a_label_can_still_be_given_for_a_saved_food(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400",
            "--label", "the skyr")
        assert one_named("bolognese")["ingredients"][0]["label"] == "the skyr (400g)"

    def test_a_liquid_food_keeps_its_own_unit(self, store):
        set_goal()
        run("food-add", "--name", "Cream", "--unit", "ml", "--kcal100", "300", "--protein100", "2",
            "--fat100", "30", "--carbs100", "3", "--serving", "100", "--asked", "--exact")
        run("prep-add", "--name", "Sauce")
        run("prep-ingredient-add", "--name", "sauce", "--food", "cream", "--amount", "200")
        ingredient = one_named("sauce")["ingredients"][0]
        assert ingredient["label"] == "Cream (200ml)"
        assert ingredient["kcal"] == 600

    def test_a_packets_per_100_rate_is_scaled_by_the_amount(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Passata", "--kcal100", "35",
            "--protein100", "1.5", "--carbs100", "7", "--amount", "700", "--exact")
        ingredient = one_named("bolognese")["ingredients"][0]
        assert ingredient["label"] == "Passata (700g)"
        assert ingredient["kcal"] == 245
        assert ingredient["protein"] == 10.5

    def test_a_bare_total_is_taken_as_it_is(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Olive oil", "--kcal", "265",
            "--fat", "30", "--exact")
        ingredient = one_named("bolognese")["ingredients"][0]
        assert ingredient["label"] == "Olive oil"
        assert ingredient["kcal"] == 265

    def test_a_scaled_ingredient_remembers_the_rate_it_came_from(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400")
        source = one_named("bolognese")["ingredients"][0]["source"]
        assert source["kind"] == "food"
        assert source["amount"] == 400
        assert source["per100"]["kcal"] == 64

    def test_a_bare_total_records_that_it_has_no_rate(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "265", "--exact")
        assert one_named("bolognese")["ingredients"][0]["source"] == {"kind": "log"}

    def test_a_food_needs_an_amount(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr")

    def test_a_rate_needs_an_amount(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--label", "X", "--kcal100", "35", "--exact")

    def test_no_numbers_at_all_says_what_the_three_ways_are(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--label", "X")
        err = capsys.readouterr().err
        assert "--food" in err and "--kcal100" in err and "--kcal" in err

    def test_a_rate_needs_a_label_to_call_it(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--kcal100", "35", "--amount", "700", "--exact")

    def test_two_rate_bases_at_once_are_refused(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400",
                "--kcal", "100", "--exact")

    def test_a_loosely_matched_food_is_announced(self, store, capsys):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyer", "--amount", "400")
        assert 'read "skyer" as Skyr, plain' in capsys.readouterr().out

    def test_a_forgotten_scaled_ingredient_still_splits_the_eaten_share(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        add_skyr()
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400")
        out = capsys.readouterr().out
        assert "forgotten" in out
        assert "logged the 128 kcal" in out


class TestIngredientReWeigh:
    def prepared(self):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400")

    def test_amount_rescales_from_the_ingredients_own_rate(self, store):
        self.prepared()
        run("prep-ingredient-edit", "--name", "bolognese", "--last", "--amount", "500")
        ingredient = one_named("bolognese")["ingredients"][0]
        assert ingredient["kcal"] == 320
        assert ingredient["protein"] == 55

    def test_it_relabels_with_the_new_amount(self, store):
        self.prepared()
        run("prep-ingredient-edit", "--name", "bolognese", "--last", "--amount", "500")
        assert one_named("bolognese")["ingredients"][0]["label"] == "Skyr, plain (500g)"

    def test_the_stored_rate_follows_the_new_amount(self, store):
        self.prepared()
        run("prep-ingredient-edit", "--name", "bolognese", "--last", "--amount", "500")
        assert one_named("bolognese")["ingredients"][0]["source"]["amount"] == 500

    def test_an_explicit_macro_still_wins_over_the_rescale(self, store):
        self.prepared()
        run("prep-ingredient-edit", "--name", "bolognese", "--last", "--amount", "500",
            "--kcal", "999")
        assert one_named("bolognese")["ingredients"][0]["kcal"] == 999

    def test_an_ingredient_with_no_rate_cannot_be_re_weighed(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "265", "--exact")
        with pytest.raises(SystemExit):
            run("prep-ingredient-edit", "--name", "bolognese", "--last", "--amount", "300")

    def test_a_label_alone_leaves_the_amount_alone(self, store):
        self.prepared()
        run("prep-ingredient-edit", "--name", "bolognese", "--last", "--label", "the skyr")
        ingredient = one_named("bolognese")["ingredients"][0]
        assert ingredient["label"] == "the skyr"
        assert ingredient["kcal"] == 256


class TestPrep:
    def test_build_up_accumulates_total(self, store, capsys):
        set_goal()
        add_bolognese()
        batch = one_named("bolognese")
        assert macros.prep_total(batch) == {"kcal": 1800, "protein": 120, "fat": 90, "carbs": 110}
        assert batch["consumption"] == []
        capsys.readouterr()
        run("prep-list")
        assert "Bolognese: 100% left" in capsys.readouterr().out

    def test_add_refuses_active_name(self, store):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-add", "--name", "Bolognese")
        assert len(live_named("bolognese")) == 1

    def test_reuses_a_finished_name(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-rest")   # finished -> auto-archived
        run("prep-add", "--name", "Bolognese")                   # reuse the name -> fresh live batch
        assert len(live_named("bolognese")) == 1
        assert len(archived_named("bolognese")) == 1
        assert live_named("bolognese")[0]["ingredients"] == []
        assert live_named("bolognese")[0]["id"] != archived_named("bolognese")[0]["id"]

    def test_eat_fraction_records_event_and_links_day_entry(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-eat", "--name", "bolo", "--of-batch", "1/5")
        assert "Bolognese (20% of batch)" in capsys.readouterr().out
        batch = one_named("bolognese")
        assert macros.frac_left(batch) == pytest.approx(0.8)
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(360)
        assert len(batch["consumption"]) == 1
        entry = day_entries()[-1]
        assert entry["source"]["prepId"] == batch["id"]
        assert entry["source"]["eventId"] == batch["consumption"][0]["id"]

    def test_finishing_auto_archives_and_retains(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-rest")
        batch = one_named("bolognese")
        assert batch["archivedAt"] is not None
        assert macros.frac_left(batch) == pytest.approx(0.0)
        capsys.readouterr()
        run("prep-list")
        assert "no active preps" in capsys.readouterr().out
        capsys.readouterr()
        run("prep-list", "--all")
        assert "Bolognese" in capsys.readouterr().out

    def test_removing_the_rest_auto_archives(self, store):
        set_goal()
        add_bolognese()
        run("prep-remove", "--name", "bolognese", "--of-rest")
        assert archived_named("bolognese")

    def test_forgotten_ingredient_after_eating_logs_share(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "200", "--exact")
        out = capsys.readouterr().out
        assert "forgotten" in out
        assert "logged the 100 kcal" in out
        batch = one_named("bolognese")
        assert macros.prep_total(batch)["kcal"] == 2000
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(1000)
        assert any(e.get("note") == "prep-fix" for e in day_entries())

    def test_later_ingredient_after_eating_goes_to_leftovers(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        before = len(day_entries())
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Cheese",
            "--kcal", "200", "--protein", "12", "--fat", "16", "--later", "--exact")
        assert "leftovers" in capsys.readouterr().out
        batch = one_named("bolognese")
        assert macros.prep_total(batch)["kcal"] == 2000
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(900)
        assert len(day_entries()) == before

    def test_add_before_eating_neither_bumps_nor_logs(self, store):
        set_goal()
        run("prep-add", "--name", "Stew")
        run("prep-ingredient-add", "--name", "stew", "--label", "A", "--kcal", "500", "--protein", "40", "--exact")
        batch = one_named("stew")
        assert batch["consumption"] == []
        assert macros.prep_total(batch)["kcal"] == 500

    def test_remove_fraction_is_unlogged(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/4")
        assert "unlogged" in capsys.readouterr().out
        batch = one_named("bolognese")
        assert macros.frac_left(batch) == pytest.approx(0.75)
        assert macros.consumed(batch, "removed")["kcal"] == pytest.approx(450)
        assert day_entries() == []

    def test_archive_keeps_the_batch(self, store):
        set_goal()
        add_bolognese()
        run("prep-archive", "--name", "bolognese")
        batch = one_named("bolognese")
        assert batch["archivedAt"] is not None
        assert macros.frac_left(batch) == pytest.approx(1.0)

    def test_archive_then_unarchive_roundtrip(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/4")   # 75% left, live
        run("prep-archive", "--name", "bolognese")
        assert archived_named("bolognese")
        capsys.readouterr()
        run("prep-list")
        assert "no active preps" in capsys.readouterr().out
        run("prep-unarchive", "--name", "bolognese")
        batch = one_named("bolognese")
        assert batch["archivedAt"] is None
        assert macros.frac_left(batch) == pytest.approx(0.75)

    def test_unarchive_refuses_when_name_is_active(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-rest")   # archived
        run("prep-add", "--name", "Bolognese")                   # fresh live one holds the name
        with pytest.raises(SystemExit):
            run("prep-unarchive", "--name", "bolognese")

    def test_get_by_id_reaches_an_archived_batch(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-rest")   # archived
        bid = archived_named("bolognese")[0]["id"]
        capsys.readouterr()
        run("prep-get", "--id", bid)
        out = capsys.readouterr().out
        assert "Bolognese" in out
        assert "archived" in out

    def test_ingredient_rm_before_eating_just_shrinks(self, store):
        set_goal()
        add_bolognese()
        run("prep-ingredient-rm", "--name", "bolognese", "--index", "2")
        batch = one_named("bolognese")
        assert len(batch["ingredients"]) == 1
        assert macros.prep_total(batch)["kcal"] == 1000
        assert batch["consumption"] == []

    def test_ingredient_rm_after_eating_unlogs_share(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Batch")
        run("prep-ingredient-add", "--name", "batch", "--label", "Base", "--kcal", "1800", "--protein", "120", "--exact")
        run("prep-ingredient-add", "--name", "batch", "--label", "Cheese", "--kcal", "300", "--exact")
        run("prep-eat", "--name", "batch", "--of-batch", "1/2")
        capsys.readouterr()
        run("prep-ingredient-rm", "--name", "batch", "--last")
        assert "un-logged the 150 kcal" in capsys.readouterr().out
        batch = one_named("batch")
        assert macros.prep_total(batch)["kcal"] == 1800
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(900)
        assert macros.frac_left(batch) == pytest.approx(0.5)

    def test_ingredient_edit_label_only_touches_no_ledger(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        before = len(day_entries())
        run("prep-ingredient-edit", "--name", "bolognese", "--index", "1", "--label", "Beef mince")
        batch = one_named("bolognese")
        assert batch["ingredients"][0]["label"] == "Beef mince"
        assert macros.prep_total(batch)["kcal"] == 1800
        assert len(day_entries()) == before

    def test_ingredient_edit_macros_after_eating_corrects(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Batch")
        run("prep-ingredient-add", "--name", "batch", "--label", "Beef", "--kcal", "1000", "--protein", "100", "--exact")
        run("prep-eat", "--name", "batch", "--of-batch", "1/2")
        capsys.readouterr()
        run("prep-ingredient-edit", "--name", "batch", "--last", "--kcal", "1200")
        assert "logged the 100 kcal" in capsys.readouterr().out
        batch = one_named("batch")
        assert macros.prep_total(batch)["kcal"] == 1200
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(600)

    def test_get_shows_log_and_split_after_others_eat(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/4")
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/5")
        capsys.readouterr()
        run("prep-get", "--name", "bolognese")
        out = capsys.readouterr().out
        assert "Beef" in out
        assert "Total: 1800 kcal" in out
        assert "Consumption:" in out
        assert "you 25%, others 20%" in out

    def test_get_no_split_when_none_removed(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-get", "--name", "bolognese")
        out = capsys.readouterr().out
        assert "others" not in out
        assert "Left: 100%" in out


class TestPrepUneat:
    def test_uneat_removed_restores(self, store):
        set_goal()
        add_bolognese()
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/5")
        run("prep-uneat", "--name", "bolognese", "--last")
        batch = one_named("bolognese")
        assert batch["consumption"] == []
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_uneat_eaten_restores_and_unlogs(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        assert day_entries()
        run("prep-uneat", "--name", "bolognese", "--last")
        batch = one_named("bolognese")
        assert batch["consumption"] == []
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_uneat_index_targets_one_event(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/5")
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/5")
        run("prep-uneat", "--name", "bolognese", "--index", "1")
        batch = one_named("bolognese")
        assert len(batch["consumption"]) == 1
        assert batch["consumption"][0]["kind"] == "removed"
        assert day_entries() == []

    def test_uneat_all_clears_everything(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/5")
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/5")
        run("prep-uneat", "--name", "bolognese", "--all")
        batch = one_named("bolognese")
        assert batch["consumption"] == []
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_unarchive_then_uneat_reopens_a_finished_batch(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-rest")   # finishes -> auto-archived
        assert archived_named("bolognese")
        run("prep-unarchive", "--name", "bolognese")
        run("prep-uneat", "--name", "bolognese", "--last")
        batch = one_named("bolognese")
        assert batch["archivedAt"] is None
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_uneat_empty_errors(self, store):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-uneat", "--name", "bolognese", "--last")

    def test_wrong_batch_incident(self, store):
        set_goal()
        add_bolognese()
        run("prep-add", "--name", "Curry")
        run("prep-ingredient-add", "--name", "curry", "--label", "All", "--kcal", "1000", "--protein", "50", "--exact")
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/5")  # mistake
        run("prep-uneat", "--name", "bolognese", "--last")               # undo it
        run("prep-remove", "--name", "curry", "--of-batch", "1/5")        # apply to the right one
        assert macros.frac_left(one_named("bolognese")) == pytest.approx(1.0)
        assert macros.frac_left(one_named("curry")) == pytest.approx(0.8)

    def test_rm_blocks_a_live_prep_entry(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        with pytest.raises(SystemExit):
            run("rm", "--last")

    def test_archived_batch_keeps_its_entry_locked(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        run("prep-archive", "--name", "bolognese")
        with pytest.raises(SystemExit):
            run("rm", "--last")          # still managed by its (archived, not deleted) batch
        assert len(day_entries()) == 1


class TestPrepSize:
    def add_ice_cream(self, kcal="3000", protein="150"):
        run("prep-add", "--name", "Ice cream", "--size", "1000")
        run("prep-ingredient-add", "--name", "ice cream", "--label", "Base",
            "--kcal", kcal, "--protein", protein, "--exact")

    def test_ml_and_pieces_formatting(self):
        assert macros.fmt_amount(500, "ml") == "500ml"
        assert macros.fmt_amount(4, "pieces") == "4 pieces"

    def test_add_with_size_then_get_shows_size(self, store, capsys):
        set_goal()
        self.add_ice_cream()
        capsys.readouterr()
        run("prep-get", "--name", "ice cream")
        assert "1000g" in capsys.readouterr().out

    def test_prep_size_sets_and_clears(self, store):
        set_goal()
        add_bolognese()
        run("prep-size", "--name", "bolognese", "--size", "1200")
        assert one_named("bolognese")["size"] == {"amount": 1200, "unit": "g"}
        run("prep-size", "--name", "bolognese", "--clear")
        assert one_named("bolognese")["size"] is None

    def test_eat_fraction_item_includes_size(self, store, capsys):
        set_goal()
        self.add_ice_cream()
        capsys.readouterr()
        run("prep-eat", "--name", "ice cream", "--of-batch", "1/4")
        assert "250g" in capsys.readouterr().out
        assert "250g" in day_entries()[-1]["item"]

    def test_eat_by_size(self, store):
        set_goal()
        self.add_ice_cream(kcal="1000", protein="100")
        run("prep-eat", "--name", "ice cream", "--size", "250")
        batch = one_named("ice cream")
        assert macros.frac_left(batch) == pytest.approx(0.75)
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(250)

    def test_eat_by_size_without_size_errors(self, store):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-eat", "--name", "bolognese", "--size", "100")

    def test_fit_kcal_reports_grams(self, store, capsys):
        set_goal()
        self.add_ice_cream()
        capsys.readouterr()
        run("prep-eat", "--name", "ice cream", "--fit-kcal", "--dry-run")
        out = capsys.readouterr().out
        assert "700g" in out
        assert "of batch" in out

    def test_prep_line_shows_size(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Soup", "--size", "900", "--unit", "ml")
        run("prep-ingredient-add", "--name", "soup", "--label", "All", "--kcal", "900", "--protein", "30", "--exact")
        capsys.readouterr()
        run("prep-list")
        assert "900ml" in capsys.readouterr().out


class TestPortionDesc:
    def batch(self, size=None):
        b = {"name": "Bolognese"}
        if size is not None:
            b["size"] = {"amount": size, "unit": "g"}
        return b

    def test_full_batch_shows_only_whole_share(self):
        assert macros.portion_desc(self.batch(), 0.3, 1.0) == "30% of batch"

    def test_partial_batch_shows_share_of_what_is_left(self):
        assert macros.portion_desc(self.batch(), 0.3, 0.6) == "50% of what's left (30% of batch)"

    def test_size_is_appended_in_both_framings(self):
        assert macros.portion_desc(self.batch(1000), 0.25, 1.0) == "25% of batch (~250g)"
        assert macros.portion_desc(self.batch(1000), 0.25, 0.5) == (
            "50% of what's left (25% of batch, ~250g)"
        )

    def test_remaining_note_real_and_dry_run(self):
        b = self.batch()
        assert macros.remaining_note(b, 0.3, 0.67, dry_run=False) == "🥘 Bolognese: 67% → 37% left"
        assert macros.remaining_note(b, 0.3, 0.67, dry_run=True) == (
            "🥘 Bolognese: 67% left now, 37% if eaten"
        )


class TestPrepPortionOutput:
    def eat_half(self):
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")

    def test_fit_target_on_partial_shows_left_framing_and_dry_run_remaining(self, store, capsys):
        set_goal()
        self.eat_half()
        capsys.readouterr()
        run("prep-eat", "--name", "bolognese", "--target-kcal", "180", "--dry-run")
        out = capsys.readouterr().out
        assert "20% of what's left (10% of batch)" in out
        assert "🥘 Bolognese: 50% left now, 40% if eaten" in out

    def test_explicit_fraction_on_partial_shows_framing_and_remaining(self, store, capsys):
        set_goal()
        self.eat_half()
        capsys.readouterr()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/4")
        out = capsys.readouterr().out
        assert "50% of what's left (25% of batch)" in out
        assert "🥘 Bolognese: 50% → 25% left" in out

    def test_full_batch_explicit_states_remaining_without_left_framing(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/4")
        out = capsys.readouterr().out
        assert "🥘 Bolognese: 100% → 75% left" in out  # remaining is always stated
        assert "of what's left" not in out               # full batch: single framing
        assert "🍽️" not in out                          # no portion line for a plain full-batch eat

    def test_full_batch_explicit_dry_run_states_remaining(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/4", "--dry-run")
        assert "🥘 Bolognese: 100% left now, 75% if eaten" in capsys.readouterr().out

    def test_full_batch_fit_shows_single_framing_and_remaining(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-eat", "--name", "bolognese", "--target-kcal", "180", "--dry-run")
        out = capsys.readouterr().out
        assert "10% of batch" in out
        assert "of what's left" not in out
        assert "🥘 Bolognese: 100% left now, 90% if eaten" in out

    def test_remove_on_partial_notes_share_of_what_was_left(self, store, capsys):
        set_goal()
        self.eat_half()
        capsys.readouterr()
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/4")
        out = capsys.readouterr().out
        assert "50% of what was left" in out
        assert "unlogged" in out

    def test_remove_on_full_batch_is_unchanged(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-remove", "--name", "bolognese", "--of-batch", "1/4")
        out = capsys.readouterr().out
        assert "removed 25% of Bolognese (unlogged - not your intake)" in out
        assert "of what was left" not in out


class TestShareDenominators:
    """The two shares differ only in what they are a share *of*, so each flag names its denominator
    and the conversion between them never happens in the caller's head."""

    def notes(self):
        return "\n".join(macros.NOTES)

    def half_eaten(self):
        set_goal()
        add_bolognese()  # 1800 kcal
        run("prep-eat", "--name", "bolognese", "--of-rest", "1/3")  # 67% left

    def test_of_rest_is_a_share_of_what_is_left(self, store):
        self.half_eaten()
        macros.NOTES.clear()
        run("prep-eat", "--name", "bolognese", "--of-rest", "0.4")
        # 40% of the 66.7% that was left, so 26.7% of the batch.
        assert macros.frac_left(one_named("bolognese")) == pytest.approx(0.4)

    def test_of_batch_is_a_share_of_everything_made(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/5")
        assert macros.frac_left(one_named("bolognese")) == pytest.approx(0.8)

    def test_of_batch_on_a_partly_eaten_batch_says_what_it_is_of_the_rest(self, store):
        # The exact confusion this pair exists to prevent: 0.268 of the batch looks arbitrary, and
        # is 40% of the leftovers.
        self.half_eaten()
        macros.NOTES.clear()
        run("prep-eat", "--name", "bolognese", "--of-batch", "0.268", "--dry-run")
        notes = self.notes()
        assert "67% left" in notes
        assert "40% of what's left" in notes
        assert "--of-rest" in notes

    def test_a_full_batch_needs_no_such_note(self, store):
        set_goal()
        add_bolognese()
        macros.NOTES.clear()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/3", "--dry-run")
        assert self.notes() == ""

    def test_of_rest_is_never_second_guessed(self, store):
        self.half_eaten()
        macros.NOTES.clear()
        run("prep-eat", "--name", "bolognese", "--of-rest", "0.4", "--dry-run")
        assert self.notes() == ""

    def test_removing_shares_read_the_same_way(self, store):
        self.half_eaten()
        run("prep-remove", "--name", "bolognese", "--of-rest", "1/2")
        assert macros.frac_left(one_named("bolognese")) == pytest.approx(1 / 3)

    def test_a_removal_of_the_batch_is_flagged_the_same_way(self, store):
        self.half_eaten()
        macros.NOTES.clear()
        run("prep-remove", "--name", "bolognese", "--of-batch", "0.1")
        assert "--of-rest" in self.notes()

    def test_naming_no_share_at_all_lists_the_ways(self, store, capsys):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-eat", "--name", "bolognese")
        err = capsys.readouterr().err
        assert "--of-rest" in err and "--of-batch" in err

    def test_the_two_shares_cannot_be_given_together(self, store):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-eat", "--name", "bolognese", "--of-rest", "1/2", "--of-batch", "1/2")

    def test_a_size_needs_a_sized_batch_and_says_so(self, store, capsys):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-eat", "--name", "bolognese", "--size", "100")
        assert "prep-size" in capsys.readouterr().err


class TestFoodListUsage:
    """The catalog is worth its entries only where they come back, so the listing shows what each
    one has earned."""

    def test_it_counts_the_days_the_food_came_back_on(self, store, capsys):
        set_goal()
        add_skyr()
        run("food-eat", "--name", "skyr", "--amount", "400", "--date", days_ago(1))
        run("food-eat", "--name", "skyr", "--amount", "500")
        capsys.readouterr()
        run("food-list")
        assert f"2 days, last {macros.dm(macros.today())}" in capsys.readouterr().out

    def test_several_helpings_in_one_day_are_one_day(self, store, capsys):
        # The same unit the threshold counts in, so the listing and the saving never disagree.
        set_goal()
        add_skyr()
        run("food-eat", "--name", "skyr", "--amount", "400")
        run("food-eat", "--name", "skyr", "--amount", "500")
        capsys.readouterr()
        run("food-list")
        assert "1 day, last" in capsys.readouterr().out

    def test_a_food_that_never_came_back_says_so_with_the_day_it_was_saved(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-list")
        assert f"never used, saved {macros.dm(macros.today())}" in capsys.readouterr().out

    def test_the_most_eaten_lead_and_the_dead_weight_collects_at_the_end(self, store, capsys):
        set_goal()
        add_skyr()
        run("food-add", "--name", "One-off", "--kcal100", "300", "--protein100", "1",
            "--fat100", "1", "--carbs100", "1", "--serving", "100", "--asked", "--exact")
        run("food-eat", "--name", "skyr", "--amount", "400")
        capsys.readouterr()
        run("food-list")
        out = capsys.readouterr().out
        assert out.index("Skyr, plain") < out.index("One-off")

    def test_an_entry_logged_before_provenance_still_counts(self, store, capsys):
        # Older entries carry no source, only the label the script itself wrote for them.
        set_goal()
        add_skyr()
        macros.ensure_day("2026-05-01")
        day = macros.load(macros.day_path("2026-05-01"), {})
        day["entries"].append({"time": "08:00", "item": "Skyr, plain (500g)", "kcal": 320,
                               "protein": 55, "fat": 0.5, "carbs": 20, "note": None})
        macros.save(macros.day_path("2026-05-01"), day)
        capsys.readouterr()
        run("food-list")
        assert "1 day, last 01.05" in capsys.readouterr().out

    def test_aliases_are_shown_only_where_they_add_something(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-list")
        out = capsys.readouterr().out
        assert "my skyr" in out
        assert "skyr, plain," not in out  # the name itself is not repeated as an alias

    def test_a_one_off_of_the_same_food_counts_as_it_coming_back(self, store, capsys):
        # The question the line answers is whether the food came back, not which command wrote it out.
        set_goal()
        add_skyr()
        run("eat", "--item", "Skyr", "--kcal100", "64", "--protein100", "11", "--fat100", "0.1",
            "--carbs100", "4", "--amount", "200", "--exact")
        capsys.readouterr()
        run("food-list")
        assert "1 day, last" in capsys.readouterr().out

    def test_an_ingredient_weighed_into_a_batch_counts_too(self, store, capsys):
        # A staple that goes into every batch has come back as surely as a snack that gets eaten.
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Ice cream")
        run("prep-ingredient-add", "--name", "ice cream", "--food", "skyr", "--amount", "1000")
        capsys.readouterr()
        run("food-list")
        assert "1 day, last" in capsys.readouterr().out

    def test_a_one_off_of_another_food_does_not(self, store, capsys):
        set_goal()
        add_skyr()
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "100", "--exact")
        capsys.readouterr()
        run("food-list")
        assert "never used" in capsys.readouterr().out

    def test_an_empty_catalog_says_so(self, store, capsys):
        run("food-list")
        assert "no foods saved" in capsys.readouterr().out


class TestFoodAddDoor:
    """`food-add` is the user's door into the catalog and nobody else's. The script keeps what
    repeats by itself, so a save with neither a repeat nor the user behind it is a guess about the
    future - and it is the guesses that fill a catalog with entries nothing ever eats again."""

    def add(self, *extra):
        run("food-add", "--name", "IKEA Köttbullar", "--kcal100", "207", "--protein100", "13",
            "--fat100", "12", "--carbs100", "9", "--serving", "15", *extra, "--exact")

    def test_it_refuses_to_save_without_the_users_say_so(self, store):
        set_goal()
        with pytest.raises(SystemExit):
            self.add()
        assert macros.load(macros.FOOD_FILE, {}) == {}

    def test_the_refusal_names_the_flag_and_what_to_do_instead(self, store, capsys):
        set_goal()
        with pytest.raises(SystemExit):
            self.add()
        err = capsys.readouterr().err
        assert "--asked" in err
        assert "`eat`" in err

    def test_repeats_are_not_required_when_the_user_asked(self, store):
        # The point of the door: a food the user names is theirs to have, first sighting or not.
        set_goal()
        self.add("--asked")
        assert macros.load(macros.FOOD_FILE, {})["ikea köttbullar"]["per100"]["kcal"] == 207

    def test_a_save_records_the_day_it_was_saved(self, store):
        set_goal()
        add_skyr()
        assert macros.load(macros.FOOD_FILE, {})["skyr, plain"]["added"] == macros.today()

    def test_a_save_is_stated_to_the_user(self, store, capsys):
        set_goal()
        add_skyr()
        assert '📌 Saved "Skyr, plain"' in capsys.readouterr().out

    def test_removing_one_is_stated_too(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-rm", "--name", "skyr")
        assert '🗑️ Removed "Skyr, plain"' in capsys.readouterr().out

    def test_editing_one_is_stated_too(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-edit", "--name", "skyr", "--kcal100", "63")
        out = capsys.readouterr().out
        assert '✏️ Updated "Skyr, plain"' in out
        assert "per 100g 63 kcal" in out


class TestRestFraction:
    def test_parses_the_usual_forms(self):
        assert macros.rest_fraction("1/2") == 0.5
        assert macros.rest_fraction("50%") == 0.5
        assert macros.rest_fraction("0.5") == 0.5
        assert macros.rest_fraction("1") == 1.0

    def test_rejects_a_share_above_one(self):
        with pytest.raises(SystemExit):
            macros.rest_fraction("3/2")


class TestPrepRestShare:
    def test_half_of_a_full_batch(self, store):
        set_goal()
        add_bolognese()  # 1800 kcal total
        run("prep-eat", "--name", "bolognese", "--of-rest", "1/2")
        batch = one_named("bolognese")
        assert macros.frac_left(batch) == pytest.approx(0.5)
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(900)

    def test_half_of_what_is_left_after_a_prior_eat(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")  # 50% left
        capsys.readouterr()
        run("prep-eat", "--name", "bolognese", "--of-rest", "1/2")  # half of the 50% = 25% of whole
        assert "50% of what's left" in capsys.readouterr().out
        batch = one_named("bolognese")
        assert macros.frac_left(batch) == pytest.approx(0.25)

    def test_bare_remaining_still_takes_all(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/4")  # 75% left
        run("prep-eat", "--name", "bolognese", "--of-rest")
        batch = one_named("bolognese")
        assert macros.frac_left(batch) == pytest.approx(0.0)

    def test_share_above_one_errors(self, store):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-eat", "--name", "bolognese", "--of-rest", "3/2")

    def test_remove_half_of_what_is_left(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")  # 50% left
        run("prep-remove", "--name", "bolognese", "--of-rest", "1/2")  # half of the 50%, unlogged
        batch = one_named("bolognese")
        assert macros.frac_left(batch) == pytest.approx(0.25)
        assert macros.consumed(batch, "removed")["kcal"] == pytest.approx(450)


class TestEdit:
    def test_edit_single_field_preserves_rest_and_ledger(self, store):
        set_goal()
        run("log", "--item", "Ice cream, large", "--kcal", "1038", "--protein", "16", "--exact")
        run("edit", "--last", "--item", "Ice cream, small", "--kcal", "538")
        entry = day_entries()[-1]
        assert entry["item"] == "Ice cream, small"
        assert entry["kcal"] == 538
        assert entry["protein"] == 16
        assert sum(e["kcal"] for e in day_entries()) == 538

    def test_edit_by_index(self, store):
        set_goal()
        run("log", "--item", "A", "--kcal", "100", "--exact")
        run("log", "--item", "B", "--kcal", "200", "--exact")
        run("edit", "--index", "1", "--kcal", "150")
        assert day_entries()[0]["kcal"] == 150

    def test_edit_requires_a_field(self, store):
        set_goal()
        run("log", "--item", "A", "--kcal", "100", "--exact")
        with pytest.raises(SystemExit):
            run("edit", "--last")

    def test_edit_out_of_range(self, store):
        set_goal()
        run("log", "--item", "A", "--kcal", "100", "--exact")
        with pytest.raises(SystemExit):
            run("edit", "--index", "5", "--kcal", "1")

    def test_edit_blocks_a_prep_entry(self, store):
        set_goal()
        run("prep-add", "--name", "B")
        run("prep-ingredient-add", "--name", "b", "--label", "x", "--kcal", "1000", "--exact")
        run("prep-eat", "--name", "b", "--of-batch", "1/2")
        with pytest.raises(SystemExit):
            run("edit", "--last", "--kcal", "400")


class TestValidation:
    def test_rejects_negative_kcal(self, store):
        with pytest.raises(SystemExit):
            run("log", "--item", "typo", "--kcal", "-50", "--exact")

    def test_allows_zero_kcal(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("log", "--item", "Black coffee", "--kcal", "0", "--exact")
        assert "0 kcal" in capsys.readouterr().out


class TestWeight:
    def test_shown_with_no_entries(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("weight", "--kg", "66.4")
        assert "Weight 66.4 kg" in capsys.readouterr().out

    def test_shown_alongside_entries(self, store, capsys):
        set_goal()
        run("weight", "--kg", "66.4")
        run("log", "--item", "A", "--kcal", "500", "--protein", "30", "--exact")
        capsys.readouterr()
        run("show")
        assert "Weight 66.4 kg" in capsys.readouterr().out

    def test_goal_shown_when_set(self, store, capsys):
        run("goal-set", "--phase", "cut", "--tdee", "2400", "--daily-goal", "2100",
            "--protein", "150", "--weight-goal", "66")
        capsys.readouterr()
        run("weight", "--kg", "66.4")
        assert "(goal 66)" in capsys.readouterr().out

    def test_no_line_when_unset(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("show")
        assert "Weight" not in capsys.readouterr().out


class TestSummary:
    def test_averages_completed_days_and_shows_today_apart(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2), "--exact")
        run("log", "--item", "B", "--kcal", "3000", "--protein", "100", "--date", days_ago(1), "--exact")
        run("log", "--item", "C", "--kcal", "479", "--protein", "30", "--exact")
        capsys.readouterr()
        run("summary", "--days", "3")
        out = capsys.readouterr().out
        assert "Avg/day over 2 days: 2500 kcal | 125g protein" in out
        assert "Today so far" in out
        assert "479 kcal" in out

    def test_spread_and_protein_goal_hits(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2), "--exact")
        run("log", "--item", "B", "--kcal", "3000", "--protein", "100", "--date", days_ago(1), "--exact")
        capsys.readouterr()
        run("summary", "--days", "3")
        out = capsys.readouterr().out
        assert "Range 2000-3000 kcal/day" in out
        assert "protein goal hit 1/2 days" in out

    def test_nothing_logged(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("summary", "--days", "7")
        assert "nothing logged" in capsys.readouterr().out

    def test_only_today_logged_has_no_average(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "479", "--protein", "30", "--exact")
        capsys.readouterr()
        run("summary", "--days", "1")
        out = capsys.readouterr().out
        assert "No complete days logged" in out
        assert "Today so far" in out

    def test_explicit_from_to_range(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", "2026-06-10", "--exact")
        run("log", "--item", "B", "--kcal", "2400", "--protein", "150", "--date", "2026-06-11", "--exact")
        capsys.readouterr()
        run("summary", "--from", "2026-06-01", "--to", "2026-06-30")
        out = capsys.readouterr().out
        assert "01.06-30.06" in out
        assert "Avg/day over 2 days: 2200 kcal" in out

    def test_weight_trend_and_average(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2), "--exact")
        run("log", "--item", "B", "--kcal", "2000", "--protein", "150", "--date", days_ago(1), "--exact")
        run("weight", "--kg", "67.2", "--date", days_ago(2))
        run("weight", "--kg", "66.4", "--date", days_ago(1))
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "Weight: 67.2 → 66.4 kg (-0.8), avg 66.8" in capsys.readouterr().out

    def test_single_weigh_in_shows_the_value(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(1), "--exact")
        run("weight", "--kg", "66.4", "--date", days_ago(1))
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "Weight: 66.4 kg (goal ?)" in capsys.readouterr().out

    def test_weigh_in_only_range_is_not_nothing_logged(self, store, capsys):
        set_goal()
        run("weight", "--kg", "66.4", "--date", days_ago(1))
        capsys.readouterr()
        run("summary", "--days", "3")
        out = capsys.readouterr().out
        assert "nothing logged" not in out
        assert "No food logged in this range." in out
        assert "Weight: 66.4 kg" in out

    def test_no_weigh_in_no_weight_line(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(1), "--exact")
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "Weight" not in capsys.readouterr().out


class TestPastDayCascade:
    def log_chain(self):
        # three completed days at goal, then a light today
        run("log", "--item", "A", "--kcal", "2100", "--protein", "150", "--date", days_ago(3), "--exact")
        run("log", "--item", "B", "--kcal", "2100", "--protein", "150", "--date", days_ago(2), "--exact")
        run("log", "--item", "C", "--kcal", "2100", "--protein", "150", "--date", days_ago(1), "--exact")
        run("log", "--item", "D", "--kcal", "500", "--protein", "40", "--exact")

    def test_editing_an_earlier_day_cascades_to_todays_stored_target(self, store):
        set_goal()
        self.log_chain()
        # a 3000 kcal surplus three days back must reach today with no explicit recompute
        run("log", "--item", "BIG", "--kcal", "3000", "--date", days_ago(3), "--exact")
        assert macros.load(macros.day_path(macros.today()), {})["target"] == 1900

    def test_past_day_log_also_prints_today(self, store, capsys):
        set_goal()
        self.log_chain()
        capsys.readouterr()
        run("log", "--item", "BIG", "--kcal", "3000", "--date", days_ago(3), "--exact")
        out = capsys.readouterr().out
        assert macros.dm(days_ago(3)) in out
        assert "Today (" in out

    def test_past_day_rm_also_prints_today(self, store, capsys):
        set_goal()
        self.log_chain()
        capsys.readouterr()
        run("rm", "--last", "--date", days_ago(3))
        assert "Today (" in capsys.readouterr().out

    def test_past_day_edit_also_prints_today(self, store, capsys):
        set_goal()
        self.log_chain()
        capsys.readouterr()
        run("edit", "--last", "--kcal", "1000", "--date", days_ago(3))
        assert "Today (" in capsys.readouterr().out

    def test_today_change_prints_a_single_block(self, store, capsys):
        set_goal()
        self.log_chain()
        capsys.readouterr()
        run("log", "--item", "E", "--kcal", "300", "--protein", "20", "--exact")
        assert capsys.readouterr().out.count("Today (") == 1


class TestWholeKcal:
    """A kcal figure handed over rather than scaled was the one door a fraction could come through,
    and the ledger carried it forward from there: one 257.4 two days back printed today as
    "Tomorrow's target: 2775.6000000000004 kcal"."""

    def test_a_handed_over_figure_is_stored_whole(self, store):
        set_goal()
        run("log", "--item", "Egg", "--kcal", "257.4", "--protein", "21", "--exact")
        assert day_entries()[-1]["kcal"] == 257

    def test_the_ledger_it_folds_into_stays_whole(self, store):
        set_goal()
        for ago in (2, 1, 0):
            run("log", "--item", "Egg", "--kcal", "257.4", "--date", days_ago(ago), "--exact")
        for path in sorted(macros.DAYS_DIR.glob("*.json")):
            day = macros.load(path, {})
            assert day["cumulative"] == int(day["cumulative"])
            assert day["target"] == int(day["target"])

    def test_the_day_it_prints_holds_no_fractional_kcal(self, store, capsys):
        set_goal()
        run("log", "--item", "Egg", "--kcal", "257.4", "--date", days_ago(1), "--exact")
        run("log", "--item", "Toast", "--kcal", "180.6", "--exact")
        capsys.readouterr()
        run("show")
        out = capsys.readouterr().out
        assert re.search(r"\d\.\d+ kcal", out) is None
        assert re.search(r"^Tomorrow's target: \d+ kcal\.$", out, re.MULTILINE)

    def test_a_kcal_goal_is_whole_too(self, store, capsys):
        # A day is seeded from the goal and keeps its own copy, so a fractional goal would ride the
        # ledger exactly as far as a fractional entry.
        run("goal-set", "--phase", "cut", "--tdee", "2400.5", "--daily-goal", "2100.5",
            "--protein", "150")
        out = capsys.readouterr().out
        assert "TDEE: 2400 kcal" in out
        assert "Daily goal: 2100 kcal" in out


class TestGoalReadBack:
    def test_an_unset_weight_goal_says_so_rather_than_printing_none(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("goal")
        out = capsys.readouterr().out
        assert "Weight goal: not set" in out
        assert "None" not in out

    def test_a_weight_goal_reads_with_its_unit(self, store, capsys):
        run("goal-set", "--phase", "cut", "--tdee", "2400", "--daily-goal", "2100",
            "--protein", "150", "--weight-goal", "66")
        assert "Weight goal: 66 kg" in capsys.readouterr().out


class TestAmounts:
    """An amount is stored exactly as it is shown, so a portion can neither round away to nothing
    nor disagree with the rate it was scaled from."""

    def test_half_a_portion_stays_half_a_portion(self, store):
        set_goal()
        run("eat", "--item", "Egg", "--unit", "pieces", "--kcal100", "7800",
            "--protein100", "630", "--amount", "0.5", "--exact")
        entry = day_entries()[-1]
        assert entry["item"] == "Egg (0.5 pieces)"
        assert entry["kcal"] == 39

    def test_a_saved_food_can_be_eaten_by_halves_too(self, store):
        set_goal()
        run("food-add", "--name", "Egg", "--unit", "pieces", "--kcal100", "7800",
            "--protein100", "630", "--fat100", "1100", "--carbs100", "60", "--serving", "2",
            "--asked", "--exact")
        run("food-eat", "--name", "egg", "--amount", "0.5")
        assert day_entries()[-1]["item"] == "Egg (0.5 pieces)"

    def test_a_weighed_amount_reads_back_as_it_was_stored(self, store):
        set_goal()
        run("eat", "--item", "Rice", "--kcal100", "130", "--amount", "234.6", "--exact")
        entry = day_entries()[-1]
        assert entry["item"] == "Rice (235g)"
        assert entry["source"]["amount"] == 235

    def test_a_prep_ingredients_label_and_its_rate_agree(self, store):
        # They diverged: the label rounded the amount while the stored rate kept it, so re-weighing
        # scaled from a number the user had never been shown.
        set_goal()
        run("prep-add", "--name", "Sauce")
        run("prep-ingredient-add", "--name", "sauce", "--label", "Passata",
            "--kcal100", "35", "--amount", "234.6", "--exact")
        ingredient = one_named("sauce")["ingredients"][0]
        assert ingredient["label"] == "Passata (235g)"
        assert ingredient["source"]["amount"] == 235

    def test_a_fitted_portion_still_reads_as_something_weighable(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("eat", "--item", "Whey", "--kcal100", "375", "--protein100", "80",
            "--fit-protein", "--dry-run", "--exact")
        assert "188g to reach your protein goal" in capsys.readouterr().out


class TestStore:
    """Where the script looks for the user's data is only observable from outside the process, so
    these run it - from a directory that is not the workspace, which is the whole point."""

    def script(self, workspace, *argv, cwd):
        return subprocess.run(
            [sys.executable, macros.__file__, *argv],
            capture_output=True,
            text=True,
            cwd=str(cwd),
            # Nothing listens here, so a delivering command fails to send instead of posting a test
            # fixture at whatever is on the default port.
            env={**os.environ, "APOLLO_WORKSPACE": str(workspace), "PORT": "1"},
        )

    def test_the_store_is_found_from_the_workspace_not_the_directory_it_runs_in(self, tmp_path):
        workspace = tmp_path / "workspace"
        (workspace / "macros").mkdir(parents=True)
        (workspace / "macros" / "goal.json").write_text(
            '{"phase": "bulk", "tdee": 2400, "dailyGoal": 2600, "proteinGoal": 150}'
        )
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        result = self.script(workspace, "goal", cwd=elsewhere)
        assert "Phase: bulk" in result.stdout

    def test_a_workspace_that_is_not_there_is_an_error_not_an_empty_ledger(self, tmp_path):
        result = self.script(tmp_path / "nope", "show", cwd=tmp_path)
        assert result.returncode == 1
        assert "no workspace at" in result.stderr
        assert "Today" not in result.stdout


class TestDelivery:
    def test_deliver_to_user_posts_and_returns_the_marker(self, monkeypatch):
        seen = {}

        class Resp:
            def read(self):
                return "\n[macros: delivered to the user \u2713 - do not relay]\n".encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            seen["data"] = request.data
            return Resp()

        monkeypatch.setattr(macros.urllib.request, "urlopen", fake_urlopen)
        marker = macros.deliver_to_user("hello")
        assert "source=macros" in seen["url"]
        assert seen["data"] == b"hello"
        assert "delivered to the user" in marker

    def test_deliver_to_user_returns_error_body_on_http_error(self, monkeypatch):
        def raise_503(request, timeout=None):
            raise macros.urllib.error.HTTPError(
                request.full_url, 503, "err", {},
                io.BytesIO("\n[macros: delivery FAILED - relay the output above to the user yourself]\n".encode("utf-8")),
            )

        monkeypatch.setattr(macros.urllib.request, "urlopen", raise_503)
        assert "delivery FAILED" in macros.deliver_to_user("hello")

    def test_deliver_to_user_returns_none_when_unreachable(self, monkeypatch):
        def boom(request, timeout=None):
            raise OSError("refused")

        monkeypatch.setattr(macros.urllib.request, "urlopen", boom)
        assert macros.deliver_to_user("hello") is None


class TestAudience:
    def deliver_spy(self, monkeypatch):
        sent = []

        def fake(text):
            sent.append(text)
            return "\n[macros: delivered to the user \u2713 - do not relay]\n"

        monkeypatch.setattr(macros, "deliver_to_user", fake)
        return sent

    def invoke(self, monkeypatch, *argv):
        monkeypatch.setattr(sys, "argv", ["macros.py", *argv])
        macros.main()

    def test_a_plain_command_sends_its_result(self, store, monkeypatch, capsys):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "show")
        assert len(sent) == 1
        assert "Target:" in sent[0]
        assert "delivered to the user" in capsys.readouterr().out

    def test_a_preview_reaches_the_user_too(self, store, monkeypatch):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "log", "--item", "Second helping", "--kcal", "600", "--dry-run", "--exact")
        assert len(sent) == 1
        assert "Second helping" in sent[0]

    def test_nothing_can_be_read_out_of_the_users_sight(self):
        parser = macros.build_parser()
        for name in ("goal", "log", "eat", "show", "summary", "weight", "rm", "entries", "edit",
                     "food-get", "food-add", "food-list", "food-eat", "food-edit", "food-rm",
                     "prep-add", "prep-eat", "prep-get", "prep-list"):
            args = parser.parse_args(macros_args(name))
            assert args.delivers is True, name
            assert not hasattr(args, "quiet"), name

    def test_the_ledger_repair_reports_to_the_caller(self, store, monkeypatch, capsys):
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "recompute")
        assert sent == []
        assert "recomputed" in capsys.readouterr().out

    def test_a_note_never_reaches_the_user(self, store, monkeypatch, capsys):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        macros.hint("[macros] a private note")
        self.invoke(monkeypatch, "show")
        assert "private note" not in sent[0]
        assert "private note" in capsys.readouterr().out

    def test_a_catalog_change_reaches_the_user(self, store, monkeypatch):
        # The catalog is the user's data, so an entry can never arrive unseen.
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "food-add", "--name", "Skyr, plain", "--kcal100", "64",
                    "--protein100", "11", "--fat100", "0.1", "--carbs100", "4",
                    "--serving", "500", "--asked", "--exact")
        assert len(sent) == 1
        assert 'Saved "Skyr, plain"' in sent[0]

    def test_a_food_the_script_saves_by_itself_reaches_the_user(self, store, monkeypatch):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        for ago in reversed(range(macros.DAYS_TO_SAVE)):
            self.invoke(monkeypatch, "eat", "--item", "Kinder", "--kcal100", "579",
                        "--protein100", "8.5", "--fat100", "35", "--carbs100", "55",
                        "--amount", "100", "--date", days_ago(ago), "--exact")
        assert len(sent) == macros.DAYS_TO_SAVE
        assert 'Saved "Kinder"' in sent[-1]


def macros_args(name):
    """The smallest valid argv for a command, so the parser can be inspected."""
    required = {
        "log": ["--item", "x", "--kcal", "1", "--exact"],
        "eat": ["--item", "x", "--kcal100", "1", "--amount", "1", "--exact"],
        "weight": ["--kg", "60"],
        "edit": ["--last", "--kcal", "1"],
        "food-get": ["x"],
        "food-add": ["--name", "x", "--kcal100", "1", "--protein100", "1", "--fat100", "1",
                     "--carbs100", "1", "--serving", "1", "--asked", "--exact"],
        "food-eat": ["--name", "x"],
        "food-edit": ["--name", "x"],
        "food-rm": ["--name", "x"],
        "prep-add": ["--name", "x"],
        "prep-eat": ["--name", "x", "--of-batch", "1/2"],
    }
    return [name, *required.get(name, [])]


class TestProvenance:
    def test_eat_records_the_rate_it_scaled_from(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "235", "--exact")
        assert day_entries()[-1]["source"] == {
            "kind": "eat", "name": "Granola", "amount": 235, "unit": "g",
            "per100": {"kcal": 450, "protein": 10, "fat": 20, "carbs": 55},
        }

    def test_food_eat_snapshots_the_food_rate(self, store):
        set_goal()
        add_skyr()
        run("food-eat", "--name", "skyr", "--amount", "400")
        source = day_entries()[-1]["source"]
        assert source["kind"] == "food"
        assert source["name"] == "Skyr, plain"
        assert source["per100"]["kcal"] == 64

    def test_a_snapshot_does_not_move_when_the_food_is_edited(self, store):
        set_goal()
        add_skyr()
        run("food-eat", "--name", "skyr", "--amount", "400")
        run("food-edit", "--name", "skyr", "--kcal100", "999")
        assert day_entries()[-1]["source"]["per100"]["kcal"] == 64

    def test_log_records_that_it_has_no_rate(self, store):
        set_goal()
        run("log", "--item", "Burger", "--kcal", "900", "--exact")
        assert day_entries()[-1]["source"] == {"kind": "log"}


class TestReScale:
    def test_amount_rescales_and_relabels(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "200", "--exact")
        run("edit", "--last", "--amount", "300")
        entry = day_entries()[-1]
        assert entry["item"] == "Granola (300g)"
        assert entry["kcal"] == 1350
        assert entry["protein"] == 30
        assert entry["source"]["amount"] == 300

    def test_rescaling_keeps_the_unit(self, store):
        set_goal()
        run("eat", "--item", "Oat drink", "--unit", "ml", "--kcal100", "46", "--amount", "250", "--exact")
        run("edit", "--last", "--amount", "500")
        assert day_entries()[-1]["item"] == "Oat drink (500ml)"

    def test_a_portion_smaller_than_one_survives_the_rescale(self, store):
        # An amount arrives at its own resolution, so re-scaling to half a piece is a correction like
        # any other - not a rounding down to nothing.
        set_goal()
        run("eat", "--item", "Egg", "--unit", "pieces", "--kcal100", "7800", "--protein100", "630",
            "--amount", "2", "--exact")
        run("edit", "--last", "--amount", "0.5")
        entry = day_entries()[-1]
        assert entry["item"] == "Egg (0.5 pieces)"
        assert entry["kcal"] == 39
        assert entry["source"]["amount"] == 0.5

    def test_an_explicit_macro_wins_over_the_rescale(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--amount", "200", "--exact")
        run("edit", "--last", "--amount", "300", "--kcal", "1000")
        assert day_entries()[-1]["kcal"] == 1000

    def test_an_entry_without_a_rate_cannot_be_rescaled(self, store):
        set_goal()
        run("log", "--item", "Burger", "--kcal", "900", "--exact")
        with pytest.raises(SystemExit):
            run("edit", "--last", "--amount", "300")


class TestSavingWhatRepeats:
    """The catalog keeps what comes back, and it does that itself: the run that logs the same rate
    for the third time is the run that saves it. Nothing is asked of the caller, because a criterion
    the script can check is not a judgement to delegate."""

    KINDER = ["--kcal100", "579", "--protein100", "8.5", "--fat100", "35", "--carbs100", "55"]

    def eat(self, item, *extra, ago=0):
        run("eat", "--item", item, *self.KINDER, "--amount", "100", "--date", days_ago(ago), *extra, "--exact")

    def eat_on(self, *agos, item="Kinder"):
        """One use on each of the given days back, since separate days are what earning an entry takes."""
        for ago in agos:
            self.eat(item, ago=ago)

    def notes(self):
        return "\n".join(macros.NOTES)

    def foods(self):
        return macros.load(macros.FOOD_FILE, {})

    def test_a_first_sighting_saves_nothing_and_says_nothing(self, store):
        set_goal()
        self.eat("Kinder")
        assert self.foods() == {}
        assert self.notes() == ""

    def test_nothing_is_saved_before_the_threshold(self, store):
        set_goal()
        self.eat_on(1, 0)
        assert self.foods() == {}

    def test_three_helpings_in_one_day_are_one_occasion(self, store):
        # A food that comes back comes back on another day. Three at one sitting is one occasion,
        # however many entries it makes, so it earns nothing.
        set_goal()
        for _ in range(5):
            self.eat("Kinder")
        assert self.foods() == {}

    def test_the_third_day_saves_it(self, store):
        set_goal()
        self.eat_on(2, 1, 0)
        saved = self.foods()["kinder"]
        assert saved["name"] == "Kinder"
        assert saved["per100"] == {"kcal": 579, "protein": 8.5, "fat": 35, "carbs": 55}
        assert saved["added"] == macros.today()

    def test_it_is_portioned_and_measured_by_what_was_eaten(self, store):
        set_goal()
        for ago in (2, 1, 0):
            run("eat", "--item", "Oat drink", "--unit", "ml", "--kcal100", "46",
                "--protein100", "1", "--amount", "250", "--date", days_ago(ago), "--exact")
        saved = self.foods()["oat drink"]
        assert saved["unit"] == "ml"
        assert saved["serving"] == 250

    def test_it_is_aliased_by_its_own_name_alone(self, store):
        # Nothing here is guessing at how the food might be referred to later; matching is forgiving.
        set_goal()
        self.eat_on(2, 1, 0)
        assert self.foods()["kinder"]["aliases"] == ["kinder"]

    def test_the_save_is_stated_to_the_user(self, store, capsys):
        set_goal()
        self.eat_on(2, 1)
        capsys.readouterr()
        self.eat("Kinder")
        out = capsys.readouterr().out
        assert '📌 Saved "Kinder"' in out
        assert "used on 3 separate days now" in out

    def test_the_caller_is_told_to_use_food_eat_from_now_on(self, store):
        set_goal()
        self.eat_on(2, 1, 0)
        assert 'food-eat --name "Kinder"' in self.notes()

    def test_the_same_rate_under_another_name_is_another_food(self, store):
        # A staple is a near-pure macronutrient, so a rate is not an identity: every sugar reads
        # 400/0/0/100 and everything calorie-free reads zero. Counting by rate alone would make one
        # product of salt and xanthan gum, and save it under whichever name came third.
        set_goal()
        for ago, name in ((2, "Salt"), (1, "Xanthan gum"), (0, "Sweetener")):
            run("eat", "--item", name, "--kcal100", "0", "--amount", "5", "--date", days_ago(ago), "--exact")
        assert self.foods() == {}

    def test_the_same_name_at_another_rate_is_another_food(self, store):
        # One name covers milk at two fat levels, so the numbers have to agree as well.
        set_goal()
        for ago, kcal, protein in ((2, "64", "3.2"), (1, "42", "3.5"), (0, "42", "3.5")):
            run("eat", "--item", "Milk", "--kcal100", kcal, "--protein100", protein,
                "--amount", "200", "--date", days_ago(ago), "--exact")
        assert self.foods() == {}

    def test_punctuation_and_case_are_not_part_of_the_name(self, store):
        set_goal()
        for ago, name in ((2, "Skyr, plain"), (1, "skyr plain"), (0, "SKYR  Plain")):
            run("eat", "--item", name, "--kcal100", "64", "--protein100", "11", "--amount", "500",
                "--date", days_ago(ago), "--exact")
        assert len(self.foods()) == 1

    def test_it_is_saved_once_and_not_again(self, store, capsys):
        set_goal()
        self.eat_on(2, 1, 0)
        capsys.readouterr()
        macros.NOTES.clear()
        self.eat("Kinder")
        assert "Saved" not in capsys.readouterr().out
        assert "already saved" in self.notes()

    def test_a_different_product_does_not_count(self, store):
        set_goal()
        self.eat_on(2, 1)
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "100", "--exact")
        assert self.foods() == {}

    def test_an_already_saved_rate_is_pointed_at_its_food_instead(self, store):
        set_goal()
        run("food-add", "--name", "Kinder Happy Hippo", "--kcal100", "579", "--protein100", "8.5",
            "--fat100", "35", "--carbs100", "55", "--serving", "100", "--asked", "--exact")
        self.eat("Kinder")
        notes = self.notes()
        assert '"Kinder Happy Hippo" is already saved' in notes
        assert 'food-eat --name "Kinder Happy Hippo"' in notes
        assert list(self.foods()) == ["kinder happy hippo"]

    def test_a_preview_counts_for_nothing(self, store):
        set_goal()
        self.eat_on(2, 1)
        self.eat("Kinder", "--dry-run")
        assert self.foods() == {}
        self.eat("Kinder")
        assert list(self.foods()) == ["kinder"]


class TestSameFood:
    """What makes two records the same food. Both a saved food and the provenance of a use carry a
    name, a rate and a unit under those names, so one comparison serves both."""

    def rate(self, kcal=717, protein=0.9, fat=81, carbs=0.1):
        return {"kcal": kcal, "protein": protein, "fat": fat, "carbs": carbs}

    def use(self, name="Butter", unit="g", amount=115, **over):
        return {"name": name, "unit": unit, "amount": amount, "per100": self.rate(**over)}

    def test_the_same_name_rate_and_unit_is_the_same_food(self):
        assert macros.same_food(self.use(), self.use()) is True

    def test_the_amount_is_not_part_of_it(self):
        # It is what the rate gets scaled by, and the one thing certain to differ between two uses.
        assert macros.same_food(self.use(amount=115), self.use(amount=227)) is True

    def test_the_same_rate_under_another_name_is_not(self):
        salt = self.use(name="Salt", kcal=0, protein=0, fat=0, carbs=0)
        gum = self.use(name="Xanthan gum", kcal=0, protein=0, fat=0, carbs=0)
        assert macros.same_food(salt, gum) is False

    def test_the_same_name_at_another_rate_is_not(self):
        assert macros.same_food(self.use(name="Milk", kcal=64), self.use(name="Milk", kcal=42)) is False

    def test_the_same_name_and_rate_in_another_unit_is_not(self):
        assert macros.same_food(self.use(unit="g"), self.use(unit="ml")) is False

    def test_case_and_punctuation_are_not_part_of_the_name(self):
        assert macros.same_food(self.use(name="Skyr, plain"), self.use(name="skyr plain")) is True
        assert macros.same_food(self.use(name="SKYR  Plain"), self.use(name="skyr-plain")) is True

    def test_a_misread_digit_is_still_the_same_rate(self):
        assert macros.same_food(self.use(kcal=717), self.use(kcal=719)) is True


class TestPrepIngredientsCount:
    """An ingredient weighed out from a rate is that rate written out by hand, exactly as a one-off
    meal is, so it counts the same toward earning an entry."""

    BUTTER = ["--kcal100", "717", "--protein100", "0.9", "--fat100", "81", "--carbs100", "0.1"]

    def into(self, batch, amount="115", label="Butter", ago=0, rate=None):
        """A batch cooked `ago` days back, with one ingredient weighed into it by hand. A batch dates
        its own ingredients, so back-dating it is how a use lands on another day."""
        run("prep-add", "--name", batch)
        if ago:
            prep = macros.load(macros.PREP_FILE, {})
            for b in prep.values():
                if b["name"] == batch:
                    b["created"] = days_ago(ago)
            macros.save(macros.PREP_FILE, prep)
        run("prep-ingredient-add", "--name", batch, "--label", label, *(rate or self.BUTTER),
            "--amount", amount, "--exact")

    def eaten(self, amount="20", label="Butter", ago=0):
        run("eat", "--item", label, *self.BUTTER, "--amount", amount, "--date", days_ago(ago), "--exact")

    def foods(self):
        return macros.load(macros.FOOD_FILE, {})

    def test_two_batches_and_a_meal_earn_the_entry(self, store):
        set_goal()
        self.into("Dough", ago=2)
        self.into("Cookies", ago=1)
        assert self.foods() == {}
        self.eaten()
        assert list(self.foods()) == ["butter"]

    def test_three_batches_earn_it_without_ever_eating_it(self, store):
        set_goal()
        for ago, batch in ((2, "Dough"), (1, "Cookies"), (0, "Brownies")):
            self.into(batch, ago=ago)
        assert list(self.foods()) == ["butter"]

    def test_two_batches_in_one_day_are_one_occasion(self, store):
        # Cooking twice on a Saturday is one day, so with a use on one other day it is two.
        set_goal()
        self.into("Dough")
        self.into("Cookies")
        self.eaten(ago=1)
        assert self.foods() == {}

    def test_it_is_measured_by_the_ingredient_that_earned_it(self, store):
        set_goal()
        for ago, batch, amount in ((2, "Dough", "115"), (1, "Cookies", "180"), (0, "Brownies", "227")):
            self.into(batch, amount=amount, ago=ago)
        saved = self.foods()["butter"]
        assert saved["per100"]["kcal"] == 717
        assert saved["serving"] == 227

    def test_the_batch_states_the_save_to_the_user(self, store, capsys):
        set_goal()
        self.into("Dough", ago=2)
        self.into("Cookies", ago=1)
        capsys.readouterr()
        self.into("Brownies")
        assert '📌 Saved "Butter"' in capsys.readouterr().out

    def test_afterwards_the_batch_command_is_the_one_suggested(self, store):
        set_goal()
        for ago, batch in ((2, "Dough"), (1, "Cookies"), (0, "Brownies")):
            self.into(batch, ago=ago)
        macros.NOTES.clear()
        self.into("Shortbread")
        notes = "\n".join(macros.NOTES)
        assert '"Butter" is already saved' in notes
        assert 'prep-ingredient-add --name "Shortbread" --food "Butter"' in notes

    def test_a_staple_that_shares_a_rate_is_not_the_same_ingredient(self, store):
        # Sugar, brown sugar and vanilla sugar all read 400/0/0/100 on this account.
        set_goal()
        sugar = ["--kcal100", "400", "--carbs100", "100"]
        for ago, batch, label in ((2, "Dough", "Sugar"), (1, "Cookies", "Brown sugar"),
                                  (0, "Brownies", "Vanilla sugar")):
            self.into(batch, amount="40", label=label, ago=ago, rate=sugar)
        assert self.foods() == {}

    def test_an_ingredient_taken_from_a_saved_food_earns_nothing_new(self, store):
        set_goal()
        add_skyr()
        for ago, batch in ((2, "Dough"), (1, "Cookies"), (0, "Brownies")):
            run("prep-add", "--name", batch)
            run("prep-ingredient-add", "--name", batch, "--food", "skyr", "--amount", "400")
        assert list(self.foods()) == ["skyr, plain"]

    def test_an_ingredient_with_only_a_total_counts_for_nothing(self, store):
        # No rate behind it, so there is nothing to save.
        set_goal()
        for ago, batch in ((2, "Dough"), (1, "Cookies"), (0, "Brownies")):
            run("prep-add", "--name", batch)
            run("prep-ingredient-add", "--name", batch, "--label", "Butter", "--kcal", "825", "--exact")
        assert self.foods() == {}

    def test_a_batch_outside_the_window_no_longer_counts(self, store):
        # Three days of use, but the first is older than the window, so two remain.
        set_goal()
        self.into("Dough")
        prep = macros.load(macros.PREP_FILE, {})
        for batch in prep.values():
            batch["created"] = "2025-01-01"
        macros.save(macros.PREP_FILE, prep)
        self.into("Cookies", ago=1)
        self.eaten()
        assert self.foods() == {}


class TestSavedFoodNamed:
    def test_exact_alias_matches(self, store):
        add_skyr()
        assert macros.saved_food_named("skyr")["name"] == "Skyr, plain"

    def test_substring_of_the_saved_name_matches(self, store):
        add_skyr()
        assert macros.saved_food_named("Skyr")["name"] == "Skyr, plain"

    def test_a_typo_does_not(self, store):
        add_skyr()
        assert macros.saved_food_named("skyer sauce") is None

    def test_an_unrelated_name_does_not(self, store):
        add_skyr()
        assert macros.saved_food_named("Bratwurst") is None

    def test_an_empty_catalog_does_not(self, store):
        assert macros.saved_food_named("Sriracha") is None


class TestGuessedOverSavedFood:
    """A one-off typed under the name of a saved food. The rate check cannot catch this: it is the
    guess being wrong that makes the numbers differ, which is exactly when the saved food mattered."""

    def save_sriracha(self):
        run("food-add", "--name", "Sriracha", "--kcal100", "137", "--protein100", "1.9",
            "--fat100", "0.9", "--carbs100", "28", "--serving", "30", "--asked", "--exact")

    def guess(self, kcal="93", item="Sriracha"):
        run("eat", "--item", item, "--kcal100", kcal, "--amount", "10", "--exact")

    def notes(self):
        return "\n".join(macros.NOTES)

    def test_names_the_saved_food_and_both_numbers(self, store):
        set_goal()
        self.save_sriracha()
        self.guess()
        notes = self.notes()
        assert '"Sriracha" already exists' in notes
        assert "137" in notes
        assert "93" in notes

    def test_offers_the_command_that_uses_the_real_numbers(self, store):
        set_goal()
        self.save_sriracha()
        self.guess()
        assert 'food-eat --name "Sriracha" --amount 10' in self.notes()

    def test_the_entry_is_still_logged(self, store):
        set_goal()
        self.save_sriracha()
        self.guess()
        assert day_entries()[-1]["item"] == "Sriracha (10g)"

    def test_a_matching_rate_reports_itself_instead(self, store):
        # A rate match needs all four values to agree, which is why the name check exists at all.
        set_goal()
        self.save_sriracha()
        run("eat", "--item", "Sriracha", "--kcal100", "137", "--protein100", "1.9",
            "--fat100", "0.9", "--carbs100", "28", "--amount", "10", "--exact")
        notes = self.notes()
        assert '"Sriracha" is already saved' in notes
        assert "already exists at" not in notes

    def test_one_matching_macro_is_not_a_matching_rate(self, store):
        set_goal()
        self.save_sriracha()
        self.guess(kcal="137")  # kcal agrees, the rest do not
        assert "already exists at" in self.notes()

    def test_an_unrelated_food_says_nothing(self, store):
        set_goal()
        self.save_sriracha()
        self.guess(item="Bratwurst")
        assert self.notes() == ""

    def test_a_typo_is_not_confident_enough_to_nag(self, store):
        set_goal()
        self.save_sriracha()
        self.guess(item="Srirachaa sauce hot")
        assert self.notes() == ""

    def test_repeated_guesses_never_overwrite_the_real_numbers(self, store):
        # A saved food of this name already answers for it, so the repeat rule must not save the
        # guess over it however many days the guess is typed on - the label data is the better record.
        set_goal()
        self.save_sriracha()
        for ago in reversed(range(macros.DAYS_TO_SAVE)):
            macros.NOTES.clear()
            run("eat", "--item", "Sriracha", "--kcal100", "93", "--amount", "10",
                "--date", days_ago(ago), "--exact")
        assert macros.load(macros.FOOD_FILE, {})["sriracha"]["per100"]["kcal"] == 137
        assert "already exists at" in self.notes()

    def test_a_preview_never_nags(self, store):
        set_goal()
        self.save_sriracha()
        run("eat", "--item", "Sriracha", "--kcal100", "93", "--amount", "10", "--dry-run", "--exact")
        assert self.notes() == ""


class TestDeclaringWhereNumbersCameFrom:
    """A rate read off a label and one recalled from memory arrive as the same four numbers, so the
    store cannot tell them apart and never guesses: every command that takes numbers by hand says
    which they are, or refuses to write them."""

    def test_a_logged_total_says_which_it_is(self, store, capsys):
        set_goal()
        with pytest.raises(SystemExit):
            run("log", "--item", "Kebap", "--kcal", "370", "--protein", "19")
        err = capsys.readouterr().err
        assert "--exact" in err and "--estimated" in err
        assert day_entries() == []

    def test_a_rate_off_a_label_says_it_too(self, store):
        set_goal()
        with pytest.raises(SystemExit):
            run("eat", "--item", "Granola", "--kcal100", "450", "--amount", "200")

    def test_a_saved_food_says_it_as_well(self, store):
        set_goal()
        with pytest.raises(SystemExit):
            run("food-add", "--name", "Beer", "--kcal100", "42", "--protein100", "0.4",
                "--fat100", "0", "--carbs100", "3.5", "--serving", "500", "--asked")
        assert macros.load(macros.FOOD_FILE, {}) == {}

    def test_an_ingredient_weighed_off_a_packet_says_it(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--label", "Passata",
                "--kcal100", "35", "--amount", "700")

    def test_an_ingredient_given_as_a_total_says_it(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "265")

    def test_an_ingredient_taken_from_a_saved_food_needs_no_declaration(self, store):
        # The food already carries it, and a weighed-out portion of it is no more of a guess.
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400")
        assert one_named("bolognese")["ingredients"][0]["estimated"] is False

    def test_the_two_cannot_be_claimed_at_once(self, store):
        set_goal()
        with pytest.raises(SystemExit):
            run("log", "--item", "Kebap", "--kcal", "370", "--exact", "--estimated")

    def test_a_guess_is_stored_as_one(self, store):
        set_goal()
        run("log", "--item", "Kebap", "--kcal", "370", "--protein", "19", "--estimated")
        assert day_entries()[-1]["estimated"] is True

    def test_a_read_figure_is_stored_as_one(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--amount", "200", "--exact")
        assert day_entries()[-1]["estimated"] is False

    def test_a_saved_food_keeps_what_its_numbers_rest_on(self, store):
        set_goal()
        run("food-add", "--name", "Beer", "--unit", "ml", "--kcal100", "42", "--protein100", "0.4",
            "--fat100", "0", "--carbs100", "3.5", "--serving", "500", "--asked", "--estimated")
        assert macros.load(macros.FOOD_FILE, {})["beer"]["estimated"] is True

    def test_an_ingredient_keeps_it_too(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "265",
            "--estimated")
        assert one_named("bolognese")["ingredients"][0]["estimated"] is True


class TestAmountsBelongToTheScript:
    """An amount beside a final total is a rate that was multiplied in-model - the one thing the
    script exists to do instead. Refused at the door, because afterwards nothing tells a scaled
    total from a transcribed one: the entry cannot be re-weighed and the arithmetic is gone."""

    def test_a_weight_in_the_item_sends_it_to_eat(self, store, capsys):
        set_goal()
        with pytest.raises(SystemExit):
            run("log", "--item", "Grapes 552g", "--kcal", "381", "--estimated")
        err = capsys.readouterr().err
        assert '"552g" is an amount' in err
        assert "eat" in err and "--kcal100" in err
        assert day_entries() == []

    def test_a_volume_counts_the_same(self, store, capsys):
        set_goal()
        with pytest.raises(SystemExit):
            run("log", "--item", "Beer 3,5l", "--kcal", "1470", "--estimated")
        assert '"3,5l" is an amount' in capsys.readouterr().err

    def test_an_amount_hidden_in_the_note_is_caught_too(self, store):
        set_goal()
        with pytest.raises(SystemExit):
            run("log", "--item", "Grapes", "--kcal", "381", "--note", "552g", "--estimated")

    def test_an_ingredient_given_as_a_total_is_held_to_it_as_well(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--label", "Olive oil 30ml",
                "--kcal", "265", "--estimated")
        assert "--kcal100" in capsys.readouterr().err

    def test_a_name_with_a_number_but_no_unit_still_logs(self, store):
        set_goal()
        run("log", "--item", "Menu 3 at the canteen", "--kcal", "800", "--estimated")
        assert day_entries()[-1]["item"] == "Menu 3 at the canteen"

    def test_the_label_the_script_writes_itself_is_never_refused(self, store):
        # `eat` puts the amount in the label, which is the shape this guard exists to produce.
        set_goal()
        run("eat", "--item", "Grapes", "--kcal100", "69", "--protein100", "0.7", "--amount", "552",
            "--estimated")
        assert day_entries()[-1]["item"] == "Grapes (552g)"


class TestNotesAreNotWhereAGuessGoes:
    """The note is prose, so nothing is ever read out of it: a guess written there is a fact the
    store cannot count, total or mark."""

    def test_a_note_that_claims_the_estimate_is_refused(self, store, capsys):
        set_goal()
        with pytest.raises(SystemExit):
            run("log", "--item", "Kebap", "--kcal", "370", "--note", "estimated", "--exact")
        assert "--estimated" in capsys.readouterr().err

    def test_however_it_is_written(self, store):
        set_goal()
        with pytest.raises(SystemExit):
            run("eat", "--item", "Chips", "--kcal100", "536", "--amount", "60",
                "--note", "Estimated (standard bag)", "--exact")

    def test_a_correction_cannot_smuggle_one_in_either(self, store):
        set_goal()
        run("log", "--item", "Kebap", "--kcal", "370", "--estimated")
        with pytest.raises(SystemExit):
            run("edit", "--last", "--note", "rough estimate")

    def test_a_note_that_says_something_else_is_kept(self, store):
        set_goal()
        run("log", "--item", "Kebap", "--kcal", "370", "--note", "with garlic sauce", "--estimated")
        assert day_entries()[-1]["note"] == "with garlic sauce"


class TestEstimatesFlowDownward:
    """A guess is in everything derived from it: a saved food's rate is in every use of it, and one
    guessed ingredient is in every portion of the batch and in whatever is left."""

    def add_beer(self, *basis):
        run("food-add", "--name", "Beer", "--unit", "ml", "--kcal100", "42", "--protein100", "0.4",
            "--fat100", "0", "--carbs100", "3.5", "--serving", "500", "--asked", *basis)

    def estimated_batch(self):
        run("prep-add", "--name", "Chili")
        run("prep-ingredient-add", "--name", "chili", "--label", "Beans", "--kcal", "1000",
            "--protein", "60", "--exact")
        run("prep-ingredient-add", "--name", "chili", "--label", "Mince", "--kcal", "800",
            "--protein", "60", "--estimated")

    def test_a_guessed_food_makes_every_use_of_it_a_guess(self, store):
        set_goal()
        self.add_beer("--estimated")
        run("food-eat", "--name", "beer", "--amount", "500")
        assert day_entries()[-1]["estimated"] is True

    def test_a_read_food_eaten_in_a_guessed_amount_is_one_too(self, store):
        set_goal()
        self.add_beer("--exact")
        run("food-eat", "--name", "beer", "--amount", "500", "--estimated")
        assert day_entries()[-1]["estimated"] is True

    def test_a_read_food_in_a_weighed_amount_is_neither(self, store):
        set_goal()
        self.add_beer("--exact")
        run("food-eat", "--name", "beer", "--amount", "500")
        assert day_entries()[-1]["estimated"] is False

    def test_a_guessed_food_weighed_into_a_batch_carries_it_in(self, store):
        set_goal()
        self.add_beer("--estimated")
        run("prep-add", "--name", "Stew")
        run("prep-ingredient-add", "--name", "stew", "--food", "beer", "--amount", "200")
        batch = one_named("stew")
        assert batch["ingredients"][0]["estimated"] is True
        assert macros.prep_estimated(batch) is True

    def test_one_guessed_ingredient_makes_the_whole_batch_a_guess(self, store):
        set_goal()
        self.estimated_batch()
        assert macros.prep_estimated(one_named("chili")) is True

    def test_every_portion_of_it_is_a_guess(self, store):
        set_goal()
        self.estimated_batch()
        run("prep-eat", "--name", "chili", "--of-batch", "1/2")
        assert day_entries()[-1]["estimated"] is True

    def test_a_read_batch_eaten_in_a_guessed_share_is_one(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-rest", "1/2", "--estimated")
        assert day_entries()[-1]["estimated"] is True

    def test_a_read_batch_in_a_named_share_is_not(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        assert day_entries()[-1]["estimated"] is False

    def test_a_forgotten_guess_lands_on_the_day_as_a_guess(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "200",
            "--estimated")
        fix = [e for e in day_entries() if e["note"] == "prep-fix"]
        assert [e["estimated"] for e in fix] == [True]

    def test_correcting_a_read_ingredient_keeps_the_correction_read(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--of-batch", "1/2")
        run("prep-ingredient-edit", "--name", "bolognese", "--index", "1", "--kcal", "1200")
        fix = [e for e in day_entries() if e["note"] == "prep-fix"]
        assert [e["estimated"] for e in fix] == [False]

    def test_a_correction_can_say_the_ingredient_was_a_guess_all_along(self, store):
        set_goal()
        add_bolognese()
        run("prep-ingredient-edit", "--name", "bolognese", "--index", "1", "--estimated")
        batch = one_named("bolognese")
        assert batch["ingredients"][0]["estimated"] is True
        assert macros.prep_estimated(batch) is True

    def test_a_correction_can_take_the_mark_off_an_entry(self, store):
        set_goal()
        run("log", "--item", "Kebap", "--kcal", "370", "--estimated")
        run("edit", "--last", "--exact")
        assert day_entries()[-1]["estimated"] is False

    def test_that_alone_counts_as_a_correction(self, store):
        set_goal()
        run("log", "--item", "Kebap", "--kcal", "370", "--exact")
        run("edit", "--last", "--estimated")
        assert day_entries()[-1]["estimated"] is True

    def test_a_saved_food_can_be_corrected_the_same_way(self, store):
        set_goal()
        self.add_beer("--estimated")
        run("food-edit", "--name", "beer", "--kcal100", "43", "--exact")
        food = macros.load(macros.FOOD_FILE, {})["beer"]
        assert food["estimated"] is False
        assert food["per100"]["kcal"] == 43


class TestEstimatesRead:
    """Wherever a guessed figure is printed it is marked, because a number the user reads is a
    number they act on - and a guess that reads like label data invites more trust than it earns."""

    def guess(self, item="Kebap", kcal="370", protein="19", *extra):
        run("log", "--item", item, "--kcal", kcal, "--protein", protein, "--estimated", *extra)

    def test_a_days_entry_is_marked_on_the_figures_it_is_a_guess_about(self, store, capsys):
        set_goal()
        self.guess()
        capsys.readouterr()
        run("show")
        assert "- Kebap - ~370 kcal, ~19g P" in capsys.readouterr().out

    def test_a_read_entry_beside_it_is_not(self, store, capsys):
        set_goal()
        self.guess()
        run("log", "--item", "Skyr", "--kcal", "320", "--protein", "55", "--exact")
        capsys.readouterr()
        run("show")
        assert "- Skyr - 320 kcal, 55g P" in capsys.readouterr().out

    def test_the_total_says_how_much_of_the_day_is_guessed(self, store, capsys):
        set_goal()
        self.guess()
        run("log", "--item", "Skyr", "--kcal", "320", "--protein", "55", "--exact")
        capsys.readouterr()
        run("show")
        assert "Total: 690 kcal (~370 estimated) |" in capsys.readouterr().out

    def test_a_day_taken_off_labels_says_nothing_of_the_sort(self, store, capsys):
        set_goal()
        run("log", "--item", "Skyr", "--kcal", "320", "--protein", "55", "--exact")
        capsys.readouterr()
        run("show")
        out = capsys.readouterr().out
        assert "Total: 320 kcal |" in out
        assert "~" not in out

    def test_the_numbered_listing_is_marked_too(self, store, capsys):
        set_goal()
        self.guess()
        capsys.readouterr()
        run("entries")
        assert "Kebap - ~370 kcal, ~19g P" in capsys.readouterr().out

    def test_a_range_says_how_solid_its_average_is(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2),
            "--estimated")
        run("log", "--item", "B", "--kcal", "2000", "--protein", "150", "--date", days_ago(1),
            "--exact")
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "50% of kcal estimated" in capsys.readouterr().out

    def test_a_range_of_read_days_says_nothing(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(1),
            "--exact")
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "estimated" not in capsys.readouterr().out

    def test_a_guessed_food_reads_as_one_wherever_it_is_looked_up(self, store, capsys):
        set_goal()
        run("food-add", "--name", "Beer", "--unit", "ml", "--kcal100", "42", "--protein100", "0.4",
            "--fat100", "0", "--carbs100", "3.5", "--serving", "500", "--asked", "--estimated")
        capsys.readouterr()
        run("food-get", "beer")
        out = capsys.readouterr().out
        assert "per 100ml ~42 kcal, ~0.4g P, ~0g F, ~3.5g C" in out
        assert "default serving 500ml" in out

    def test_the_catalog_listing_tags_it(self, store, capsys):
        set_goal()
        run("food-add", "--name", "Beer", "--kcal100", "42", "--protein100", "0.4", "--fat100", "0",
            "--carbs100", "3.5", "--serving", "500", "--asked", "--estimated")
        add_skyr()
        capsys.readouterr()
        run("food-list")
        out = capsys.readouterr().out
        assert "- Beer  never used, saved" in out
        assert "\u00b7  estimated" in out
        assert "Skyr, plain" in out and "Skyr, plain  never used, saved" in out

    def test_a_portion_of_a_guessed_food_is_marked_as_it_is_sized(self, store, capsys):
        set_goal()
        run("food-add", "--name", "Whey", "--kcal100", "375", "--protein100", "80", "--fat100", "5",
            "--carbs100", "8", "--serving", "30", "--asked", "--estimated")
        capsys.readouterr()
        run("food-eat", "--name", "whey", "--fit-protein", "--dry-run")
        assert re.search(r"\U0001f37d\ufe0f Whey: .*~\d+ kcal, ~\d+", capsys.readouterr().out)

    def test_a_one_off_off_a_guessed_rate_is_marked_the_same_way(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("eat", "--item", "Whey", "--kcal100", "375", "--protein100", "80", "--fit-protein",
            "--estimated")
        assert re.search(r"\U0001f37d\ufe0f Whey: .*~\d+ kcal, ~\d+", capsys.readouterr().out)

    def test_a_batch_reads_as_a_guess_from_the_ingredient_that_makes_it_one(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Chili")
        run("prep-ingredient-add", "--name", "chili", "--label", "Beans", "--kcal", "1000",
            "--protein", "60", "--exact")
        run("prep-ingredient-add", "--name", "chili", "--label", "Mince", "--kcal", "800",
            "--protein", "60", "--estimated")
        capsys.readouterr()
        run("prep-get", "--name", "chili")
        out = capsys.readouterr().out
        assert "1. Beans - 1000 kcal, 60g P" in out
        assert "2. Mince - ~800 kcal, ~60g P" in out
        assert "Total: ~1800 kcal, ~120g P" in out
        assert "Left: 100% (~1800 kcal, ~120g P)" in out

    def test_the_batch_listing_is_marked_too(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Chili")
        run("prep-ingredient-add", "--name", "chili", "--label", "Mince", "--kcal", "800",
            "--protein", "60", "--estimated")
        capsys.readouterr()
        run("prep-list")
        assert "Chili: 100% left (~800 kcal, ~60g P)" in capsys.readouterr().out

    def test_adding_a_guessed_ingredient_says_so_as_it_lands(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Chili")
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "chili", "--label", "Mince", "--kcal", "800",
            "--protein", "60", "--estimated")
        assert "added to Chili: Mince - ~800 kcal, ~60g P" in capsys.readouterr().out

    def test_a_batch_taken_off_labels_prints_plain_figures(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-get", "--name", "bolognese")
        assert "~" not in capsys.readouterr().out


class TestSavingAGuessedFood:
    """Produce, a restaurant meal and a beer poured from the tap never carry a label, so the catalog
    has to be able to hold a food it only ever guessed at - as a guess, not as label data."""

    GRAPES = ["--kcal100", "69", "--protein100", "0.7", "--fat100", "0.2", "--carbs100", "18"]

    def eat_grapes(self, ago, *basis):
        run("eat", "--item", "Grapes", *self.GRAPES, "--amount", "552", "--date", days_ago(ago),
            *basis)

    def foods(self):
        return macros.load(macros.FOOD_FILE, {})

    def test_a_food_earned_by_guesses_is_kept_as_a_guess(self, store):
        set_goal()
        for ago in (2, 1, 0):
            self.eat_grapes(ago, "--estimated")
        assert self.foods()["grapes"]["estimated"] is True

    def test_the_save_says_so_to_the_user(self, store, capsys):
        set_goal()
        for ago in (2, 1):
            self.eat_grapes(ago, "--estimated")
        capsys.readouterr()
        self.eat_grapes(0, "--estimated")
        assert '\U0001f4cc Saved "Grapes" to your foods (estimated figures)' in capsys.readouterr().out

    def test_a_food_earned_off_labels_is_kept_without_the_mark(self, store, capsys):
        set_goal()
        for ago in (2, 1):
            self.eat_grapes(ago, "--exact")
        capsys.readouterr()
        self.eat_grapes(0, "--exact")
        out = capsys.readouterr().out
        assert self.foods()["grapes"]["estimated"] is False
        assert "estimated figures" not in out

    def test_every_later_use_of_it_inherits_the_guess(self, store):
        set_goal()
        for ago in (2, 1, 0):
            self.eat_grapes(ago, "--estimated")
        run("food-eat", "--name", "grapes", "--amount", "200")
        assert day_entries()[-1]["estimated"] is True

    def test_a_label_for_a_guessed_food_is_offered_to_the_food_itself(self, store):
        # The saved entry is the guess, and these numbers are read - so the fix is to put them on it,
        # not to prefer the guess over them.
        set_goal()
        run("food-add", "--name", "Grapes", "--kcal100", "50", "--protein100", "0.5",
            "--fat100", "0.1", "--carbs100", "12", "--serving", "200", "--asked", "--estimated")
        macros.NOTES.clear()
        self.eat_grapes(0, "--exact")
        notes = "\n".join(macros.NOTES)
        assert 'the saved "Grapes" is an estimate at 50 kcal/100g' in notes
        assert 'food-edit --name "Grapes" --kcal100 69' in notes
        assert "--exact" in notes

    def test_a_guess_over_a_read_food_is_still_sent_to_the_food(self, store):
        set_goal()
        run("food-add", "--name", "Grapes", "--kcal100", "50", "--protein100", "0.5",
            "--fat100", "0.1", "--carbs100", "12", "--serving", "200", "--asked", "--exact")
        macros.NOTES.clear()
        self.eat_grapes(0, "--estimated")
        notes = "\n".join(macros.NOTES)
        assert 'a saved food "Grapes" already exists at 50 kcal/100g' in notes
        assert 'food-eat --name "Grapes" --amount 552' in notes
