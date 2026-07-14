import argparse

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


class TestPrep:
    def test_add_eat_fraction_then_rm(self, store, capsys):
        set_goal()
        run("prep-add", "--name", "Bolognese", "--kcal", "1800",
            "--protein", "120", "--fat", "90", "--carbs", "110")
        capsys.readouterr()
        run("prep-eat", "--name", "bolo", "--fraction", "1/5")
        assert "Bolognese (20% of batch)" in capsys.readouterr().out
        assert macros.load(macros.PREP_FILE, {})["bolognese"]["remaining"] == pytest.approx(0.8)
        run("prep-rm", "--name", "bolognese")
        assert macros.load(macros.PREP_FILE, {}) == {}


class TestValidation:
    def test_rejects_negative_kcal(self, store):
        with pytest.raises(SystemExit):
            run("log", "--item", "typo", "--kcal", "-50")

    def test_allows_zero_kcal(self, store, capsys):
        set_goal()
        capsys.readouterr()
        run("log", "--item", "Black coffee", "--kcal", "0")
        assert "0 kcal" in capsys.readouterr().out
