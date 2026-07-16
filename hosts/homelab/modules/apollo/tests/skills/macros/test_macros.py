import argparse
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
        "--fat100", "0.1", "--carbs100", "4", "--serving", "500", "--aliases", "skyr,my skyr")


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
    return (datetime.now() - timedelta(days=n)).strftime("%Y-%m-%d")


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
            "--fat100", "5", "--carbs100", "8", "--serving", "30")
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
        run("food-eat", "--name", "skyer", "--grams", "100")
        assert 'read "skyer" as Skyr, plain' in capsys.readouterr().out

    def test_exact_match_makes_no_assumption(self, store, capsys):
        set_goal()
        add_skyr()
        capsys.readouterr()
        run("food-eat", "--name", "skyr", "--grams", "100")
        assert "read" not in capsys.readouterr().out


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


class TestPrep:
    def test_build_up_accumulates_total(self, store, capsys):
        set_goal()
        add_bolognese()
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert macros.prep_total(batch) == {"kcal": 1800, "protein": 120, "fat": 90, "carbs": 110}
        assert batch["consumption"] == []
        capsys.readouterr()
        run("prep-list")
        assert "Bolognese: 100% left" in capsys.readouterr().out

    def test_add_refuses_existing_name(self, store):
        set_goal()
        add_bolognese()
        with pytest.raises(SystemExit):
            run("prep-add", "--name", "Bolognese")
        assert "bolognese" in macros.load(macros.PREP_FILE, {})

    def test_eat_fraction_records_event_and_links_day_entry(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-eat", "--name", "bolo", "--fraction", "1/5")
        assert "Bolognese (20% of batch)" in capsys.readouterr().out
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert macros.frac_left(batch) == pytest.approx(0.8)
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(360)
        assert len(batch["consumption"]) == 1
        entry = day_entries()[-1]
        assert entry["prepKey"] == "bolognese"
        assert entry["eventId"] == batch["consumption"][0]["id"]

    def test_finishing_retains_the_batch_hidden(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--remaining")
        prep = macros.load(macros.PREP_FILE, {})
        assert "bolognese" in prep
        assert macros.frac_left(prep["bolognese"]) == pytest.approx(0.0)
        capsys.readouterr()
        run("prep-list")
        assert "no active preps" in capsys.readouterr().out
        capsys.readouterr()
        run("prep-list", "--all")
        assert "Bolognese" in capsys.readouterr().out

    def test_forgotten_ingredient_after_eating_logs_share(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/2")
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Oil", "--kcal", "200")
        out = capsys.readouterr().out
        assert "forgotten" in out
        assert "logged the 100 kcal" in out
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert macros.prep_total(batch)["kcal"] == 2000
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(1000)
        assert any(e.get("note") == "prep-fix" for e in day_entries())

    def test_later_ingredient_after_eating_goes_to_leftovers(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/2")
        before = len(day_entries())
        capsys.readouterr()
        run("prep-ingredient-add", "--name", "bolognese", "--label", "Cheese",
            "--kcal", "200", "--protein", "12", "--fat", "16", "--later")
        assert "leftovers" in capsys.readouterr().out
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert macros.prep_total(batch)["kcal"] == 2000
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(900)
        assert len(day_entries()) == before

    def test_add_before_eating_neither_bumps_nor_logs(self, store):
        set_goal()
        run("prep-add", "--name", "Stew")
        run("prep-ingredient-add", "--name", "stew", "--label", "A", "--kcal", "500", "--protein", "40")
        batch = macros.load(macros.PREP_FILE, {})["stew"]
        assert batch["consumption"] == []
        assert macros.prep_total(batch)["kcal"] == 500

    def test_remove_fraction_is_unlogged(self, store, capsys):
        set_goal()
        add_bolognese()
        capsys.readouterr()
        run("prep-remove", "--name", "bolognese", "--fraction", "1/4")
        assert "unlogged" in capsys.readouterr().out
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert macros.frac_left(batch) == pytest.approx(0.75)
        assert macros.consumed(batch, "removed")["kcal"] == pytest.approx(450)
        assert day_entries() == []

    def test_rm_deletes_the_batch(self, store):
        set_goal()
        add_bolognese()
        run("prep-rm", "--name", "bolognese")
        assert macros.load(macros.PREP_FILE, {}) == {}

    def test_ingredient_rm_before_eating_just_shrinks(self, store):
        set_goal()
        add_bolognese()
        run("prep-ingredient-rm", "--name", "bolognese", "--index", "2")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert len(batch["ingredients"]) == 1
        assert macros.prep_total(batch)["kcal"] == 1000
        assert batch["consumption"] == []

    def test_ingredient_rm_after_eating_unlogs_share(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Batch")
        run("prep-ingredient-add", "--name", "batch", "--label", "Base", "--kcal", "1800", "--protein", "120")
        run("prep-ingredient-add", "--name", "batch", "--label", "Cheese", "--kcal", "300")
        run("prep-eat", "--name", "batch", "--fraction", "1/2")
        capsys.readouterr()
        run("prep-ingredient-rm", "--name", "batch", "--last")
        assert "un-logged the 150 kcal" in capsys.readouterr().out
        batch = macros.load(macros.PREP_FILE, {})["batch"]
        assert macros.prep_total(batch)["kcal"] == 1800
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(900)
        assert macros.frac_left(batch) == pytest.approx(0.5)

    def test_ingredient_edit_label_only_touches_no_ledger(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/2")
        before = len(day_entries())
        run("prep-ingredient-edit", "--name", "bolognese", "--index", "1", "--label", "Beef mince")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert batch["ingredients"][0]["label"] == "Beef mince"
        assert macros.prep_total(batch)["kcal"] == 1800
        assert len(day_entries()) == before

    def test_ingredient_edit_macros_after_eating_corrects(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Batch")
        run("prep-ingredient-add", "--name", "batch", "--label", "Beef", "--kcal", "1000", "--protein", "100")
        run("prep-eat", "--name", "batch", "--fraction", "1/2")
        capsys.readouterr()
        run("prep-ingredient-edit", "--name", "batch", "--last", "--kcal", "1200")
        assert "logged the 100 kcal" in capsys.readouterr().out
        batch = macros.load(macros.PREP_FILE, {})["batch"]
        assert macros.prep_total(batch)["kcal"] == 1200
        assert macros.consumed(batch, "eaten")["kcal"] == pytest.approx(600)

    def test_get_shows_log_and_split_after_others_eat(self, store, capsys):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/4")
        run("prep-remove", "--name", "bolognese", "--fraction", "1/5")
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
        run("prep-remove", "--name", "bolognese", "--fraction", "1/5")
        run("prep-uneat", "--name", "bolognese", "--last")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert batch["consumption"] == []
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_uneat_eaten_restores_and_unlogs(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/2")
        assert day_entries()
        run("prep-uneat", "--name", "bolognese", "--last")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert batch["consumption"] == []
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_uneat_index_targets_one_event(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/5")
        run("prep-remove", "--name", "bolognese", "--fraction", "1/5")
        run("prep-uneat", "--name", "bolognese", "--index", "1")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert len(batch["consumption"]) == 1
        assert batch["consumption"][0]["kind"] == "removed"
        assert day_entries() == []

    def test_uneat_all_clears_everything(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/5")
        run("prep-remove", "--name", "bolognese", "--fraction", "1/5")
        run("prep-uneat", "--name", "bolognese", "--all")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
        assert batch["consumption"] == []
        assert macros.frac_left(batch) == pytest.approx(1.0)
        assert day_entries() == []

    def test_uneat_after_finishing_reopens_batch(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--remaining")
        run("prep-uneat", "--name", "bolognese", "--last")
        batch = macros.load(macros.PREP_FILE, {})["bolognese"]
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
        run("prep-remove", "--name", "bolognese", "--fraction", "1/5")  # mistake
        run("prep-uneat", "--name", "bolognese", "--last")               # undo it
        run("prep-remove", "--name", "curry", "--fraction", "1/5")        # apply to the right one
        prep = macros.load(macros.PREP_FILE, {})
        assert macros.frac_left(prep["bolognese"]) == pytest.approx(1.0)
        assert macros.frac_left(prep["curry"]) == pytest.approx(0.8)

    def test_rm_blocks_a_live_prep_entry(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/2")
        with pytest.raises(SystemExit):
            run("rm", "--last")

    def test_rm_allows_prep_entry_after_batch_deleted(self, store):
        set_goal()
        add_bolognese()
        run("prep-eat", "--name", "bolognese", "--fraction", "1/2")
        run("prep-rm", "--name", "bolognese")
        run("rm", "--last")
        assert day_entries() == []


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
        assert macros.load(macros.PREP_FILE, {})["bolognese"]["size"] == {"amount": 1200, "unit": "g"}
        run("prep-size", "--name", "bolognese", "--clear")
        assert macros.load(macros.PREP_FILE, {})["bolognese"]["size"] is None

    def test_eat_fraction_item_includes_size(self, store, capsys):
        set_goal()
        self.add_ice_cream()
        capsys.readouterr()
        run("prep-eat", "--name", "ice cream", "--fraction", "1/4")
        assert "250g" in capsys.readouterr().out
        assert "250g" in day_entries()[-1]["item"]

    def test_eat_by_size(self, store):
        set_goal()
        self.add_ice_cream(kcal="1000", protein="100")
        run("prep-eat", "--name", "ice cream", "--size", "250")
        batch = macros.load(macros.PREP_FILE, {})["ice cream"]
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
        run("prep-eat", "--name", "b", "--fraction", "1/2")
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
