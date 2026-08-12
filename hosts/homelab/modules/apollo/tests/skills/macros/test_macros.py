import argparse
import io
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
    macros.ANNOUNCEMENTS.clear()
    root = tmp_path / "macros"
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
        "--asked")


def add_bolognese():
    run("prep-add", "--name", "Bolognese")
    run("prep-ingredient-add", "--name", "bolognese", "--label", "Beef", "--kcal", "1000",
        "--protein", "100", "--fat", "60", "--carbs", "0")
    run("prep-ingredient-add", "--name", "bolognese", "--label", "Passata", "--kcal", "800",
        "--protein", "20", "--fat", "30", "--carbs", "110")


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


class TestNonneg:
    def test_allows_zero(self):
        assert macros.nonneg("0") == 0

    def test_allows_positive(self):
        assert macros.nonneg("42") == 42

    def test_rejects_negative(self):
        with pytest.raises(argparse.ArgumentTypeError):
            macros.nonneg("-1")


class TestPositive:
    def test_allows_positive(self):
        assert macros.positive("5") == 5

    def test_rejects_zero(self):
        with pytest.raises(argparse.ArgumentTypeError):
            macros.positive("0")

    def test_rejects_negative(self):
        with pytest.raises(argparse.ArgumentTypeError):
            macros.positive("-3")


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
            "--fat100", "5", "--carbs100", "8", "--serving", "30", "--asked")
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
            "--asked")

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
            "--fat100", "20", "--carbs100", "55", "--amount", "200")
        entry = day_entries()[-1]
        assert entry["item"] == "Granola (200g)"
        assert entry["kcal"] == 900
        assert entry["protein"] == 20
        assert entry["fat"] == 40
        assert entry["carbs"] == 110

    def test_unit_defaults_to_grams(self, store):
        set_goal()
        run("eat", "--item", "Rice", "--kcal100", "130", "--amount", "150")
        assert "Rice (150g)" in day_entries()[-1]["item"]

    def test_ml_unit_labels_the_amount(self, store):
        set_goal()
        run("eat", "--item", "Oat drink", "--unit", "ml", "--kcal100", "46",
            "--protein100", "1", "--amount", "500")
        assert "Oat drink (500ml)" in day_entries()[-1]["item"]

    def test_other_macros_default_to_zero(self, store):
        set_goal()
        run("eat", "--item", "Sugar", "--kcal100", "400", "--amount", "50")
        entry = day_entries()[-1]
        assert entry["kcal"] == 200
        assert entry["protein"] == 0
        assert entry["fat"] == 0
        assert entry["carbs"] == 0

    def test_kcal100_is_required(self, store):
        with pytest.raises(SystemExit):
            run("eat", "--item", "Mystery", "--amount", "100")

    def test_amount_or_target_required(self, store):
        with pytest.raises(SystemExit):
            run("eat", "--item", "Granola", "--kcal100", "450")

    def test_note_passthrough(self, store):
        set_goal()
        run("eat", "--item", "Chips", "--kcal100", "536", "--amount", "60", "--note", "estimated")
        assert day_entries()[-1]["note"] == "estimated"

    def test_dry_run_saves_nothing(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("eat", "--item", "Granola", "--kcal100", "450", "--amount", "200", "--dry-run")
        assert "preview" in capsys.readouterr().out
        assert day_entries() == []

    def test_fit_protein_sizes_and_logs(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("eat", "--item", "Whey", "--kcal100", "375", "--protein100", "80", "--fit-protein")
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
            "--fat100", "30", "--carbs100", "3", "--serving", "100", "--asked")
        run("prep-add", "--name", "Sauce")
        run("prep-ingredient-add", "--name", "sauce", "--food", "cream", "--amount", "200")
        ingredient = one_named("sauce")["ingredients"][0]
        assert ingredient["label"] == "Cream (200ml)"
        assert ingredient["kcal"] == 600

    def test_a_packets_per_100_rate_is_scaled_by_the_amount(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Passata", "--kcal100", "35",
            "--protein100", "1.5", "--carbs100", "7", "--amount", "700")
        ingredient = one_named("bolognese")["ingredients"][0]
        assert ingredient["label"] == "Passata (700g)"
        assert ingredient["kcal"] == 245
        assert ingredient["protein"] == 10.5

    def test_a_bare_total_is_taken_as_it_is(self, store):
        set_goal()
        run("prep-add", "--name", "Bolognese")
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Olive oil", "--kcal", "265",
            "--fat", "30")
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
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "265")
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
            run("prep-ingredient-add", "--name", "bolognese", "--label", "X", "--kcal100", "35")

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
            run("prep-ingredient-add", "--name", "bolognese", "--kcal100", "35", "--amount", "700")

    def test_two_rate_bases_at_once_are_refused(self, store):
        set_goal()
        add_skyr()
        run("prep-add", "--name", "Bolognese")
        with pytest.raises(SystemExit):
            run("prep-ingredient-add", "--name", "bolognese", "--food", "skyr", "--amount", "400",
                "--kcal", "100")

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
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "265")
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
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "200")
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
            "--kcal", "200", "--protein", "12", "--fat", "16", "--later")
        assert "leftovers" in capsys.readouterr().out
        batch = one_named("bolognese")
        assert macros.prep_total(batch)["kcal"] == 2000
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(900)
        assert len(day_entries()) == before

    def test_add_before_eating_neither_bumps_nor_logs(self, store):
        set_goal()
        run("prep-add", "--name", "Stew")
        run("prep-ingredient-add", "--name", "stew", "--label", "A", "--kcal", "500", "--protein", "40")
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
        run("prep-ingredient-add", "--name", "batch", "--label", "Base", "--kcal", "1800", "--protein", "120")
        run("prep-ingredient-add", "--name", "batch", "--label", "Cheese", "--kcal", "300")
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
        run("prep-ingredient-add", "--name", "batch", "--label", "Beef", "--kcal", "1000", "--protein", "100")
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
        run("prep-ingredient-add", "--name", "curry", "--label", "All", "--kcal", "1000", "--protein", "50")
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
            "--kcal", kcal, "--protein", protein)

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
        run("prep-ingredient-add", "--name", "soup", "--label", "All", "--kcal", "900", "--protein", "30")
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

    def test_it_counts_how_often_a_food_was_eaten_and_when_last(self, store, capsys):
        set_goal()
        add_skyr()
        run("food-eat", "--name", "skyr", "--amount", "400")
        run("food-eat", "--name", "skyr", "--amount", "500")
        capsys.readouterr()
        run("food-list")
        assert f"2x, last {macros.dm(macros.today())}" in capsys.readouterr().out

    def test_one_helping_reads_as_once(self, store, capsys):
        set_goal()
        add_skyr()
        run("food-eat", "--name", "skyr", "--amount", "400")
        capsys.readouterr()
        run("food-list")
        assert "once, last" in capsys.readouterr().out

    def test_a_food_that_never_came_back_says_so_with_the_day_it_was_saved(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-list")
        assert f"never eaten, saved {macros.dm(macros.today())}" in capsys.readouterr().out

    def test_the_most_eaten_lead_and_the_dead_weight_collects_at_the_end(self, store, capsys):
        set_goal()
        add_skyr()
        run("food-add", "--name", "One-off", "--kcal100", "300", "--protein100", "1",
            "--fat100", "1", "--carbs100", "1", "--serving", "100", "--asked")
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
        assert "once, last 01.05" in capsys.readouterr().out

    def test_aliases_are_shown_only_where_they_add_something(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-list")
        out = capsys.readouterr().out
        assert "my skyr" in out
        assert "skyr, plain," not in out  # the name itself is not repeated as an alias

    def test_a_one_off_of_the_same_rate_counts_as_the_food_coming_back(self, store, capsys):
        # The question the line answers is whether the food came back, not which command logged it.
        set_goal()
        add_skyr()
        run("eat", "--item", "Skyr", "--kcal100", "64", "--protein100", "11", "--fat100", "0.1",
            "--carbs100", "4", "--amount", "200")
        capsys.readouterr()
        run("food-list")
        assert "once, last" in capsys.readouterr().out

    def test_a_one_off_of_another_rate_does_not(self, store, capsys):
        set_goal()
        add_skyr()
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "100")
        capsys.readouterr()
        run("food-list")
        assert "never eaten" in capsys.readouterr().out

    def test_an_empty_catalog_says_so(self, store, capsys):
        run("food-list")
        assert "no foods saved" in capsys.readouterr().out


class TestFoodAddDoor:
    """`food-add` is the user's door into the catalog and nobody else's. The script keeps what
    repeats by itself, so a save with neither a repeat nor the user behind it is a guess about the
    future - and it is the guesses that fill a catalog with entries nothing ever eats again."""

    def add(self, *extra):
        run("food-add", "--name", "IKEA Köttbullar", "--kcal100", "207", "--protein100", "13",
            "--fat100", "12", "--carbs100", "9", "--serving", "15", *extra)

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
        assert any("Skyr, plain" in line for line in macros.ANNOUNCEMENTS)

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
        run("log", "--item", "Ice cream (415g)", "--kcal", "1038", "--protein", "16")
        run("edit", "--last", "--item", "Ice cream (215g)", "--kcal", "538")
        entry = day_entries()[-1]
        assert entry["item"] == "Ice cream (215g)"
        assert entry["kcal"] == 538
        assert entry["protein"] == 16
        assert sum(e["kcal"] for e in day_entries()) == 538

    def test_edit_by_index(self, store):
        set_goal()
        run("log", "--item", "A", "--kcal", "100")
        run("log", "--item", "B", "--kcal", "200")
        run("edit", "--index", "1", "--kcal", "150")
        assert day_entries()[0]["kcal"] == 150

    def test_edit_requires_a_field(self, store):
        set_goal()
        run("log", "--item", "A", "--kcal", "100")
        with pytest.raises(SystemExit):
            run("edit", "--last")

    def test_edit_out_of_range(self, store):
        set_goal()
        run("log", "--item", "A", "--kcal", "100")
        with pytest.raises(SystemExit):
            run("edit", "--index", "5", "--kcal", "1")

    def test_edit_blocks_a_prep_entry(self, store):
        set_goal()
        run("prep-add", "--name", "B")
        run("prep-ingredient-add", "--name", "b", "--label", "x", "--kcal", "1000")
        run("prep-eat", "--name", "b", "--of-batch", "1/2")
        with pytest.raises(SystemExit):
            run("edit", "--last", "--kcal", "400")


class TestValidation:
    def test_rejects_negative_kcal(self, store):
        with pytest.raises(SystemExit):
            run("log", "--item", "typo", "--kcal", "-50")

    def test_allows_zero_kcal(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("log", "--item", "Black coffee", "--kcal", "0")
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
        run("log", "--item", "A", "--kcal", "500", "--protein", "30")
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
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2))
        run("log", "--item", "B", "--kcal", "3000", "--protein", "100", "--date", days_ago(1))
        run("log", "--item", "C", "--kcal", "479", "--protein", "30")
        capsys.readouterr()
        run("summary", "--days", "3")
        out = capsys.readouterr().out
        assert "Avg/day over 2 days: 2500 kcal | 125g protein" in out
        assert "Today so far" in out
        assert "479 kcal" in out

    def test_spread_and_protein_goal_hits(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2))
        run("log", "--item", "B", "--kcal", "3000", "--protein", "100", "--date", days_ago(1))
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
        run("log", "--item", "A", "--kcal", "479", "--protein", "30")
        capsys.readouterr()
        run("summary", "--days", "1")
        out = capsys.readouterr().out
        assert "No complete days logged" in out
        assert "Today so far" in out

    def test_explicit_from_to_range(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", "2026-06-10")
        run("log", "--item", "B", "--kcal", "2400", "--protein", "150", "--date", "2026-06-11")
        capsys.readouterr()
        run("summary", "--from", "2026-06-01", "--to", "2026-06-30")
        out = capsys.readouterr().out
        assert "01.06-30.06" in out
        assert "Avg/day over 2 days: 2200 kcal" in out

    def test_weight_trend_and_average(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(2))
        run("log", "--item", "B", "--kcal", "2000", "--protein", "150", "--date", days_ago(1))
        run("weight", "--kg", "67.2", "--date", days_ago(2))
        run("weight", "--kg", "66.4", "--date", days_ago(1))
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "Weight: 67.2 → 66.4 kg (-0.8), avg 66.8" in capsys.readouterr().out

    def test_single_weigh_in_shows_the_value(self, store, capsys):
        set_goal()
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(1))
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
        run("log", "--item", "A", "--kcal", "2000", "--protein", "150", "--date", days_ago(1))
        capsys.readouterr()
        run("summary", "--days", "3")
        assert "Weight" not in capsys.readouterr().out


class TestPastDayCascade:
    def log_chain(self):
        # three completed days at goal, then a light today
        run("log", "--item", "A", "--kcal", "2100", "--protein", "150", "--date", days_ago(3))
        run("log", "--item", "B", "--kcal", "2100", "--protein", "150", "--date", days_ago(2))
        run("log", "--item", "C", "--kcal", "2100", "--protein", "150", "--date", days_ago(1))
        run("log", "--item", "D", "--kcal", "500", "--protein", "40")

    def test_editing_an_earlier_day_cascades_to_todays_stored_target(self, store):
        set_goal()
        self.log_chain()
        # a 3000 kcal surplus three days back must reach today with no explicit recompute
        run("log", "--item", "BIG", "--kcal", "3000", "--date", days_ago(3))
        assert macros.load(macros.day_path(macros.today()), {})["target"] == 1900

    def test_past_day_log_also_prints_today(self, store, capsys):
        set_goal()
        self.log_chain()
        capsys.readouterr()
        run("log", "--item", "BIG", "--kcal", "3000", "--date", days_ago(3))
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
        run("log", "--item", "E", "--kcal", "300", "--protein", "20")
        assert capsys.readouterr().out.count("Today (") == 1


class TestDelivery:
    def test_output_goes_to_the_user_by_default(self):
        assert macros.should_deliver(False, False) is True

    def test_dry_run_does_not_deliver(self):
        assert macros.should_deliver(True, False) is False

    def test_quiet_does_not_deliver(self):
        assert macros.should_deliver(False, True) is False

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

    def test_quiet_sends_nothing_and_says_so(self, store, monkeypatch, capsys):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "show", "--quiet")
        out = capsys.readouterr().out
        assert sent == []
        assert "Target:" in out                      # the caller still sees everything
        assert "quiet - not sent to the user" in out

    def test_every_command_accepts_quiet(self):
        parser = macros.build_parser()
        for name in ("goal", "log", "eat", "show", "summary", "weight", "rm", "entries", "edit",
                     "food-get", "food-add", "food-list", "food-eat", "food-edit", "food-rm",
                     "prep-add", "prep-eat", "prep-get", "prep-list", "recompute"):
            args = parser.parse_args(macros_args(name))
            assert hasattr(args, "quiet"), name

    def test_a_note_never_reaches_the_user(self, store, monkeypatch, capsys):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        macros.hint("[macros] a private note")
        self.invoke(monkeypatch, "show")
        assert "private note" not in sent[0]
        assert "private note" in capsys.readouterr().out

    def test_a_catalog_change_reaches_the_user_even_when_the_run_was_quiet(self, store, monkeypatch):
        # The catalog is the user's data, so an entry can never arrive unseen.
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "food-add", "--name", "Skyr, plain", "--kcal100", "64",
                    "--protein100", "11", "--fat100", "0.1", "--carbs100", "4",
                    "--serving", "500", "--asked", "--quiet")
        assert len(sent) == 1
        assert 'Saved "Skyr, plain"' in sent[0]

    def test_only_the_change_is_sent_not_the_report_it_came_with(self, store, monkeypatch):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        self.invoke(monkeypatch, "food-add", "--name", "Skyr, plain", "--kcal100", "64",
                    "--protein100", "11", "--fat100", "0.1", "--carbs100", "4",
                    "--serving", "500", "--asked", "--quiet")
        assert "per 100g" not in sent[0]

    def test_a_food_the_script_saves_is_sent_while_the_day_stays_private(self, store, monkeypatch):
        set_goal()
        sent = self.deliver_spy(monkeypatch)
        for _ in range(macros.REPEATS_TO_SAVE):
            self.invoke(monkeypatch, "eat", "--item", "Kinder", "--kcal100", "579",
                        "--protein100", "8.5", "--fat100", "35", "--carbs100", "55",
                        "--amount", "100", "--quiet")
        assert len(sent) == 1
        assert 'Saved "Kinder"' in sent[0]
        assert "Target:" not in sent[0]


def macros_args(name):
    """The smallest valid argv for a command, so the parser can be inspected."""
    required = {
        "log": ["--item", "x", "--kcal", "1"],
        "eat": ["--item", "x", "--kcal100", "1", "--amount", "1"],
        "weight": ["--kg", "60"],
        "edit": ["--last", "--kcal", "1"],
        "food-get": ["x"],
        "food-add": ["--name", "x", "--kcal100", "1", "--protein100", "1", "--fat100", "1",
                     "--carbs100", "1", "--serving", "1", "--asked"],
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
            "--fat100", "20", "--carbs100", "55", "--amount", "235")
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
        run("log", "--item", "Burger", "--kcal", "900")
        assert day_entries()[-1]["source"] == {"kind": "log"}


class TestReScale:
    def test_amount_rescales_and_relabels(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "200")
        run("edit", "--last", "--amount", "300")
        entry = day_entries()[-1]
        assert entry["item"] == "Granola (300g)"
        assert entry["kcal"] == 1350
        assert entry["protein"] == 30
        assert entry["source"]["amount"] == 300

    def test_rescaling_keeps_the_unit(self, store):
        set_goal()
        run("eat", "--item", "Oat drink", "--unit", "ml", "--kcal100", "46", "--amount", "250")
        run("edit", "--last", "--amount", "500")
        assert day_entries()[-1]["item"] == "Oat drink (500ml)"

    def test_an_explicit_macro_wins_over_the_rescale(self, store):
        set_goal()
        run("eat", "--item", "Granola", "--kcal100", "450", "--amount", "200")
        run("edit", "--last", "--amount", "300", "--kcal", "1000")
        assert day_entries()[-1]["kcal"] == 1000

    def test_an_entry_without_a_rate_cannot_be_rescaled(self, store):
        set_goal()
        run("log", "--item", "Burger", "--kcal", "900")
        with pytest.raises(SystemExit):
            run("edit", "--last", "--amount", "300")


class TestSavingWhatRepeats:
    """The catalog keeps what comes back, and it does that itself: the run that logs the same rate
    for the third time is the run that saves it. Nothing is asked of the caller, because a criterion
    the script can check is not a judgement to delegate."""

    KINDER = ["--kcal100", "579", "--protein100", "8.5", "--fat100", "35", "--carbs100", "55"]

    def eat(self, item, *extra):
        run("eat", "--item", item, *self.KINDER, "--amount", "100", *extra)

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
        self.eat("Kinder")
        self.eat("Kinder")
        assert self.foods() == {}

    def test_the_third_log_saves_it(self, store):
        set_goal()
        for _ in range(macros.REPEATS_TO_SAVE):
            self.eat("Kinder")
        saved = self.foods()["kinder"]
        assert saved["name"] == "Kinder"
        assert saved["per100"] == {"kcal": 579, "protein": 8.5, "fat": 35, "carbs": 55}
        assert saved["added"] == macros.today()

    def test_it_is_portioned_and_measured_by_what_was_eaten(self, store):
        set_goal()
        for _ in range(macros.REPEATS_TO_SAVE):
            run("eat", "--item", "Oat drink", "--unit", "ml", "--kcal100", "46",
                "--protein100", "1", "--amount", "250")
        saved = self.foods()["oat drink"]
        assert saved["unit"] == "ml"
        assert saved["serving"] == 250

    def test_it_is_aliased_by_its_own_name_alone(self, store):
        # Nothing here is guessing at how the food might be referred to later; matching is forgiving.
        set_goal()
        for _ in range(macros.REPEATS_TO_SAVE):
            self.eat("Kinder")
        assert self.foods()["kinder"]["aliases"] == ["kinder"]

    def test_the_save_is_stated_to_the_user(self, store, capsys):
        set_goal()
        for _ in range(macros.REPEATS_TO_SAVE):
            capsys.readouterr()
            self.eat("Kinder")
        out = capsys.readouterr().out
        assert '📌 Saved "Kinder"' in out
        assert "logged 3x now" in out

    def test_the_caller_is_told_to_use_food_eat_from_now_on(self, store):
        set_goal()
        for _ in range(macros.REPEATS_TO_SAVE):
            self.eat("Kinder")
        assert 'food-eat --name "Kinder"' in self.notes()

    def test_a_differently_worded_label_still_counts_as_the_same_product(self, store):
        # The label of the log that earned it is the one that sticks; the user can rename it.
        set_goal()
        self.eat("Kinder Happy Hippo")
        run("eat", "--item", "Kinder hazelnut", "--kcal100", "580", "--protein100", "8.4",
            "--fat100", "35", "--carbs100", "55.2", "--amount", "100")
        self.eat("Kinder pieces")
        assert list(self.foods()) == ["kinder pieces"]

    def test_it_is_saved_once_and_not_again(self, store, capsys):
        set_goal()
        for _ in range(macros.REPEATS_TO_SAVE):
            self.eat("Kinder")
        capsys.readouterr()
        macros.NOTES.clear()
        self.eat("Kinder")
        assert "Saved" not in capsys.readouterr().out
        assert "already saved" in self.notes()

    def test_a_different_product_does_not_count(self, store):
        set_goal()
        self.eat("Kinder")
        self.eat("Kinder")
        run("eat", "--item", "Granola", "--kcal100", "450", "--protein100", "10",
            "--fat100", "20", "--carbs100", "55", "--amount", "100")
        assert self.foods() == {}

    def test_an_already_saved_rate_is_pointed_at_its_food_instead(self, store):
        set_goal()
        run("food-add", "--name", "Kinder Happy Hippo", "--kcal100", "579", "--protein100", "8.5",
            "--fat100", "35", "--carbs100", "55", "--serving", "100", "--asked")
        self.eat("Kinder")
        notes = self.notes()
        assert "already saved" in notes
        assert 'food-eat --name "Kinder Happy Hippo"' in notes
        assert list(self.foods()) == ["kinder happy hippo"]

    def test_a_preview_counts_for_nothing(self, store):
        set_goal()
        for _ in range(2):
            self.eat("Kinder")
        self.eat("Kinder", "--dry-run")
        assert self.foods() == {}
        self.eat("Kinder")
        assert list(self.foods()) == ["kinder"]


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
            "--fat100", "0.9", "--carbs100", "28", "--serving", "30", "--asked")

    def guess(self, kcal="93", item="Sriracha"):
        run("eat", "--item", item, "--kcal100", kcal, "--amount", "10")

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
            "--fat100", "0.9", "--carbs100", "28", "--amount", "10")
        notes = self.notes()
        assert "this rate is already saved" in notes
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
        # guess over it however often the guess is typed - the label data is the better record.
        set_goal()
        self.save_sriracha()
        for _ in range(macros.REPEATS_TO_SAVE):
            macros.NOTES.clear()
            self.guess()
        assert macros.load(macros.FOOD_FILE, {})["sriracha"]["per100"]["kcal"] == 137
        assert "already exists at" in self.notes()

    def test_a_preview_never_nags(self, store):
        set_goal()
        self.save_sriracha()
        run("eat", "--item", "Sriracha", "--kcal100", "93", "--amount", "10", "--dry-run")
        assert self.notes() == ""
