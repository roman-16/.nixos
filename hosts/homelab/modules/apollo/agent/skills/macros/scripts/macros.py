#!/usr/bin/env python3
"""Daily nutrition tracker.

Owns all storage, arithmetic, the rolling balance ledger, and output rendering,
so none of it is ever done in-model. JSON lives under macros/ in the workspace,
found from there wherever this is run from, and must only ever be changed
through this script.
"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import re
import secrets
import sys
import tempfile
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from typing import NamedTuple

# The one place the user's data lives. Anchored to the workspace rather than the working directory,
# because where this script is run from says nothing about where their ledger is - and a store looked
# for in the wrong place reads exactly like a store with nothing in it.
WORKSPACE = Path(os.environ.get("APOLLO_WORKSPACE") or Path.home() / "workspace")
MACROS_DIR = WORKSPACE / "macros"
DAYS_DIR = MACROS_DIR / "days"
GOAL_FILE = MACROS_DIR / "goal.json"
FOOD_FILE = MACROS_DIR / "food.json"
PREP_FILE = MACROS_DIR / "prep.json"

# Score below which difflib stops proposing a fuzzy name match (0..1).
FUZZY_CUTOFF = 0.6

# The user's day rolls over at this hour, not midnight: times before it count toward the
# previous calendar date (a 02:00 snack lands on the day before).
DAY_START_HOUR = 4

# The four macro keys every food, day, and portion is measured in, in display order.
MACROS = ("kcal", "protein", "fat", "carbs")

# On how many separate days the same food has to be written out by hand before the catalog keeps it,
# and how far back that counting looks. Days rather than times, because the question is whether the
# food comes back, and three helpings at one sitting is one occasion.
DAYS_TO_SAVE = 3
REPEAT_WINDOW_DAYS = 90

# Slack that still counts two rates as the same numbers. All four values must agree, so the tolerance
# absorbs a misread digit without ever merging two genuinely different rates.
KCAL_TOLERANCE = 3
MACRO_TOLERANCE = 0.5

# Everything in a name that does not identify the food: case, punctuation and spacing.
NAME_NOISE = re.compile(r"[^a-z0-9]+")


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# Notes addressed to the caller rather than the user. What gets delivered is the command's printed
# result - the document built up inside the output buffer - so these are collected during the run
# and written after it, outside that buffer: same stream, never part of what the user receives.
NOTES: list = []


def hint(msg: str):
    """Tell the caller something the user has no reason to read."""
    NOTES.append(msg)


def announce(msg: str):
    """State a change to the user's catalog, as part of the reply they get either way."""
    print(msg)


def macro_date(dt: datetime) -> str:
    """The macro-day of a timestamp: the day rolls over at DAY_START_HOUR, so a time
    before it (e.g. a 02:00 snack) counts toward the previous calendar date."""
    return (dt - timedelta(hours=DAY_START_HOUR)).strftime("%Y-%m-%d")


def today() -> str:
    return macro_date(datetime.now())


def now_time() -> str:
    return datetime.now().strftime("%H:%M")


def parse_date(value: str):
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except ValueError:
        die(f'invalid date "{value}" (use YYYY-MM-DD)')


def numify(value) -> float | int:
    """Parse a number, tolerating thousands separators; int when whole."""
    x = float(str(value).replace(",", ""))
    return int(x) if x == int(x) else x


def r1(x) -> float | int:
    x = round(float(x), 1)
    return int(x) if x == int(x) else x


def tidy_amount(x) -> float | int:
    """An amount as it reads: whole from 10 up, one decimal below - so half an egg stays half an egg
    and 234.6g of passata reads as 235g. Applied where an amount is settled as well as where one is
    printed, so the amount stored is always the amount shown."""
    x = float(x)
    return round(x) if x >= 10 else r1(x)


def quantity(resolve, *, positive: bool = False):
    """An argparse type for a number at its own quantity's resolution.

    A kilocalorie has no fractional part here: labels are whole, and nothing distinguishes 257 from
    257.4. That matters more than tidiness, because this store keeps a ledger - a fraction logged
    once lands in that day's cumulative, is inherited by every later day through prev_cumulative,
    and comes back out as "Tomorrow's target: 2775.6000000000004 kcal". Rounding it at the print
    site would only hide it, and recompute cannot lift it out again, since it re-derives from the
    same entry. So the unit is settled here at the door - whole for kcal, a tenth for grams, as-read
    for amounts - and everything derived from it downstream is exact by construction, with no print
    site left to remember anything.

    The sign is judged before the value is resolved, so a slip like --kcal -0.4 still errors out
    instead of arriving as a harmless-looking 0.
    """

    def parse(value) -> float | int:
        x = numify(value)
        if x < 0 or (positive and x <= 0):
            raise argparse.ArgumentTypeError("must be > 0" if positive else "must be >= 0")
        x = resolve(x)
        if positive and x <= 0:
            raise argparse.ArgumentTypeError(f"{value} is too small to record")
        return x

    return parse


# The quantities this store deals in, named after the resolution they keep: a flag's name says what
# it measures, its type says what a number in it means.
AMOUNT = quantity(tidy_amount, positive=True)
TENTH = quantity(r1)
TENTH_POSITIVE = quantity(r1, positive=True)
WHOLE = quantity(round)
WHOLE_POSITIVE = quantity(round, positive=True)


def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def parse_fraction(s: str) -> float:
    s = s.strip()
    if "/" in s:
        a, b = s.split("/", 1)
        return float(a) / float(b)
    if s.endswith("%"):
        return float(s[:-1]) / 100
    return float(s)


def rest_fraction(value: str) -> float:
    """An --of-rest amount as a fraction of what's *left* ("1/2", "50%", "0.5"; the bare flag passes
    "1" for all of it). It's a share of the leftovers, so it can't exceed 1."""
    frac = parse_fraction(value)
    if frac > 1 + 1e-6:
        die("an --of-rest amount is a share of what's left, so it can't exceed 1 "
            "(use --of-rest on its own to take all of it)")
    return frac


class Match(NamedTuple):
    """Outcome of resolving a food/prep reference.

    kind is one of: "exact"/"substring" (confident: key + value set); "fuzzy"
    (key + value hold the top close match and candidates lists every close name -
    the logging path may accept a lone candidate, destructive ops must not);
    "ambiguous" (several substring hits: key + value None, candidates set); or
    "none" (no match).
    """

    key: str | None
    value: dict | None
    kind: str
    candidates: list


def labels_of(key: str, value: dict) -> set:
    return {key.lower(), value.get("name", "").lower(), *(a.lower() for a in value.get("aliases", []))}


def find(mapping: dict, query: str) -> Match:
    """Resolve a reference by a confidence ladder - exact, then unique substring,
    then (only when both miss) a stdlib fuzzy match - and never silently pick a
    winner when several candidates tie."""
    q = query.lower().strip()
    if not q:
        return Match(None, None, "none", [])
    for key, value in mapping.items():
        if q in labels_of(key, value):
            return Match(key, value, "exact", [])
    subs = [(key, value) for key, value in mapping.items() if any(q in label for label in labels_of(key, value))]
    if len(subs) == 1:
        return Match(subs[0][0], subs[0][1], "substring", [])
    if subs:
        return Match(None, None, "ambiguous", [value["name"] for _, value in subs])
    pool: dict = {}
    for key, value in mapping.items():
        for label in labels_of(key, value):
            pool.setdefault(label, (key, value))
    close: dict = {}
    for label in difflib.get_close_matches(q, list(pool), n=5, cutoff=FUZZY_CUTOFF):
        key, value = pool[label]
        close.setdefault(key, value)
    if not close:
        return Match(None, None, "none", [])
    items = list(close.items())
    return Match(items[0][0], items[0][1], "fuzzy", [value["name"] for _, value in items])


def resolve(mapping: dict, query: str, *, noun: str, listing: str, strict: bool) -> tuple:
    """find() plus the shared action-path policy. Returns (key, value, assumed),
    where assumed is the display name to announce when a lone fuzzy match was
    accepted (log paths only) and None otherwise. Dies on ambiguity, on a fuzzy
    hit under strict (destructive ops re-run with the exact name), and on a miss.
    """
    match = find(mapping, query)
    if match.kind in ("exact", "substring"):
        return match.key, match.value, None
    if match.kind == "fuzzy" and not strict and len(match.candidates) == 1:
        return match.key, match.value, match.value["name"]
    if match.kind == "fuzzy":
        joined = ", ".join(match.candidates)
        if strict:
            die(f'no exact match for "{query}" - closest: {joined}. Re-run with the exact name (see {listing}).')
        die(f'no exact match for "{query}" - did you mean: {joined}? Or check {listing}.')
    if match.kind == "ambiguous":
        die(f'"{query}" matches several: {", ".join(match.candidates)}. Be more specific.')
    die(f'no {noun} matches "{query}" - check {listing}, add it, or log an estimate.')


# --- ledger --------------------------------------------------------------

def day_path(date: str) -> Path:
    return DAYS_DIR / f"{date}.json"


def prev_day_path(date: str):
    if not DAYS_DIR.exists():
        return None
    earlier = sorted(p for p in DAYS_DIR.glob("*.json") if len(p.stem) == 10 and p.stem < date)
    return earlier[-1] if earlier else None


def floor_of(day: dict) -> int:
    return day["tdee"] - 500 if day["dailyGoal"] <= day["tdee"] else day["tdee"]


def prev_cumulative(date: str, phase: str) -> float | int:
    prev = prev_day_path(date)
    if prev is None:
        return 0
    pd = load(prev, {})
    return pd.get("cumulative", 0) if pd.get("phase") == phase else 0


def _apply_ledger(day: dict) -> dict:
    """Set a day's cumulative + target from its own entries and the previous
    day's cumulative (reset on a phase change). Mutates and returns the dict;
    reads other days but never writes."""
    prevcum = prev_cumulative(day["date"], day["phase"])
    actual = sum(e["kcal"] for e in day["entries"])
    day["cumulative"] = prevcum + actual - day["dailyGoal"]
    day["target"] = max(day["dailyGoal"] - prevcum, floor_of(day))
    return day


def refresh_ledger(date: str):
    """Sole writer of a day's cumulative + target."""
    path = day_path(date)
    if path.exists():
        save(path, _apply_ledger(load(path, {})))


def recompute_from(date: str):
    """Re-fold the ledger for `date` and every later day in order (a change to an
    earlier day cascades forward through the rolling balance)."""
    days = sorted(p.stem for p in DAYS_DIR.glob("*.json")) if DAYS_DIR.exists() else []
    for d in days:
        if len(d) == 10 and d >= date:
            refresh_ledger(d)


def blank_day(date: str, goal: dict) -> dict:
    """A fresh day seeded from the goal: the target starts at the daily goal, the ledger at zero."""
    return {
        "date": date, "phase": goal.get("phase"), "tdee": goal.get("tdee"),
        "dailyGoal": goal.get("dailyGoal"), "proteinGoal": goal.get("proteinGoal"),
        "target": goal.get("dailyGoal"), "cumulative": 0, "weight": None, "entries": [],
    }


def compute_day(date: str, extra_entries=()) -> dict | None:
    """A day's in-memory snapshot with the ledger applied and `extra_entries`
    appended, persisting nothing. Uses the stored day, or synthesizes one from
    the goal when nothing is logged yet; returns None when there is neither a
    day nor a goal (so callers can prompt for goal-set)."""
    path = day_path(date)
    if path.exists():
        day = load(path, {})
    elif GOAL_FILE.exists():
        day = blank_day(date, load(GOAL_FILE, {}))
    else:
        return None
    if extra_entries:
        day = {**day, "entries": [*day["entries"], *extra_entries]}
    return _apply_ledger(day)


def day_macros(date: str) -> dict | None:
    """A logged day's summed macros plus its protein goal, or None when the day
    has no entries (so unlogged days never count toward an average)."""
    path = day_path(date)
    if not path.exists():
        return None
    day = load(path, {})
    entries = day.get("entries", [])
    if not entries:
        return None
    return {"macros": {k: sum(e[k] for e in entries) for k in MACROS}, "proteinGoal": day.get("proteinGoal")}


def day_weight(date: str) -> float | int | None:
    """The day's recorded weight in kg, or None when none was logged that day (independent of
    whether any food was logged, so a weigh-in-only day still counts)."""
    path = day_path(date)
    if not path.exists():
        return None
    w = load(path, {}).get("weight")
    return w["kg"] if w else None


def ensure_day(date: str):
    if day_path(date).exists():
        return
    if not GOAL_FILE.exists():
        die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
    save(day_path(date), blank_day(date, load(GOAL_FILE, {})))
    refresh_ledger(date)


def make_entry(time, item, kcal, protein, fat, carbs, note, *, source) -> dict:
    """One logged entry. `source` records how it was produced - the per-100 rate and amount behind
    it, the food or batch it came from - so an entry stays re-scalable, and so repeats of the same
    label are recognisable later. Without it the numbers survive but their derivation is lost."""
    return {
        "time": time, "item": item, "kcal": kcal,
        "protein": protein, "fat": fat, "carbs": carbs, "note": note or None,
        "source": source,
    }


def rate_source(kind: str, name: str, per100: dict, amount, unit: str) -> dict:
    """Provenance for an entry scaled from a per-100 rate. The rate is snapshotted rather than
    referenced, so editing a saved food later never moves numbers on days already logged."""
    return {
        "kind": kind, "name": name, "amount": amount, "unit": unit,
        "per100": {k: per100[k] for k in MACROS},
    }


def same_per100(a: dict, b: dict) -> bool:
    """Whether two per-100 rates are the same numbers, allowing for label-reading slack."""
    if abs(a.get("kcal", 0) - b.get("kcal", 0)) > KCAL_TOLERANCE:
        return False
    return all(abs(a.get(k, 0) - b.get(k, 0)) <= MACRO_TOLERANCE for k in ("protein", "fat", "carbs"))


def normal(name: str) -> str:
    """A name reduced to what identifies it, so "Skyr, plain" and "skyr plain" are one name."""
    return NAME_NOISE.sub(" ", name.lower()).strip()


def same_food(a: dict, b: dict) -> bool:
    """Whether two records are the same food: the same name, the same rate, the same unit. Both a
    saved food and the provenance of a use carry those three under those names, so one comparison
    serves wherever the question is asked.

    All three are needed. The rate alone is not a food: a kitchen staple is a near-pure
    macronutrient, so every sugar reads 400/0/0/100 and everything calorie-free reads zero, and
    counting by rate would make one product of salt and xanthan gum. The name alone is not a food
    either, since one name covers milk at two fat levels. The amount is deliberately not part of it:
    it is what the rate gets scaled by, and the one thing certain to differ between two uses of the
    same food.
    """
    if a.get("unit", "g") != b.get("unit", "g"):
        return False
    if normal(a.get("name", "")) != normal(b.get("name", "")):
        return False
    return same_per100(a.get("per100") or {}, b.get("per100") or {})


def saved_food_for(foods: dict, use: dict):
    """The saved food a hand-written use belongs to, or None - so a food already in the catalog is
    never written out by hand a second time.

    The numbers have to agree, the name only has to refer to the same thing: a deliberate entry called
    "Skyr, plain" is what "Skyr" means. That forgiveness is safe here in a way it is not when deciding
    what earns an entry (see same_food), because it takes a saved food to match against - so it can
    recognise a spelling, never invent a food out of two staples that share a rate.
    """
    match = find(foods, use.get("name", ""))
    if match.kind not in ("exact", "substring"):
        return None
    food = match.value
    if food.get("unit", "g") != use.get("unit", "g"):
        return None
    return food if same_per100(food.get("per100", {}), use.get("per100") or {}) else None


def typed_days(use: dict, upto: str) -> int:
    """On how many separate days this food has been written out by hand lately: as a one-off meal, and
    as an ingredient weighed into a batch. Both are the same act - a rate typed in because the catalog
    has no entry for it - so both count toward earning one.

    Days, not times: a food that comes back comes back on another day, while three helpings at one
    sitting are one occasion however many entries they make. A batch dates all of its ingredients, so
    reaching for the same thing twice while cooking is one day too.

    The entries and the batches are the count, so removing either lowers it by itself and nothing
    separate has to be kept in step. An ingredient carries no date of its own, so its batch dates it:
    a batch is built over hours or days, which a window of months forgives.
    """
    start = (parse_date(upto) - timedelta(days=REPEAT_WINDOW_DAYS)).strftime("%Y-%m-%d")
    days = set()
    for path in sorted(DAYS_DIR.glob("*.json")) if DAYS_DIR.exists() else []:
        if not start <= path.stem <= upto:
            continue
        for entry in load(path, {}).get("entries", []):
            source = entry.get("source") or {}
            if source.get("kind") == "eat" and same_food(use, source):
                days.add(path.stem)
    for batch in load(PREP_FILE, {}).values():
        created = batch.get("created", "")
        if not start <= created <= upto:
            continue
        for ingredient in batch["ingredients"]:
            source = ingredient.get("source") or {}
            if source.get("kind") == "eat" and same_food(use, source):
                days.add(created)
    return len(days)


def saved_food_named(item: str):
    """A saved food that this label refers to, or None. Only a confident match counts - an exact
    alias or a single substring hit - because the nudge it feeds is unsolicited and a fuzzy read of
    "chicken breast" as "chicken thigh" would be worse than saying nothing."""
    match = find(load(FOOD_FILE, {}), item)
    return match.value if match.kind in ("exact", "substring") else None


def keep_food(use: dict, amount):
    """Take a hand-written food into the catalog, on the use that earned it. Named, measured and
    portioned after what was actually written out, and aliased only by its own name, because nothing
    here is guessing at how the food might be referred to later."""
    food = load(FOOD_FILE, {})
    name, unit = use["name"], use.get("unit", "g")
    key = name.lower()
    food[key] = {
        "name": name,
        "per100": {k: use["per100"][k] for k in MACROS},
        "serving": amount,
        "unit": unit,
        "aliases": [key],
        "added": today(),
    }
    save(FOOD_FILE, food)
    announce(f'📌 Saved "{name}" to your foods: used on {DAYS_TO_SAVE} separate days now, default '
             f"serving {fmt_amount(amount, unit)}. food-rm to drop it.")
    hint(f'[macros] saved from repeats - from now on: food-eat --name "{name}"')


def reconcile_catalog(use: dict, amount, date: str, use_saved):
    """What the catalog makes of a food written out by hand, whether that was a one-off meal or an
    ingredient weighed into a batch: it is already saved, so the wrong command was used; a different
    food already answers to this name, so the numbers were guessed over real label data; or it has now
    been written out often enough that the catalog keeps it, which it does here rather than asking for
    it to be done. A first sighting is none of those and passes in silence, because an entry is only
    worth having once the food has come back.

    `use_saved(name)` renders the command that would have used the saved food instead, since only the
    caller knows its own grammar.
    """
    saved = saved_food_for(load(FOOD_FILE, {}), use)
    if saved:
        hint(f'[macros] "{saved["name"]}" is already saved - next time: {use_saved(saved["name"])}')
        return
    # The check above needs the numbers to agree as well, so a guess wide of the saved food slips past
    # it - which is exactly when the saved food was worth having. The gap between the two is the
    # point: it says the typed numbers are wrong, not merely redundant.
    named = saved_food_named(use["name"])
    if named:
        saved_unit = named.get("unit", "g")
        hint(f'[macros] a saved food "{named["name"]}" already exists at '
             f'{named["per100"]["kcal"]} kcal/100{saved_unit}, but this was written out at '
             f'{use["per100"]["kcal"]}. Its numbers come off the label, so prefer it unless this '
             f'really is a different food:\n  {use_saved(named["name"])}')
        return
    # >= rather than ==, so a food that somehow passed the threshold unsaved is taken in on its next
    # use instead of being missed for good.
    if typed_days(use, date) >= DAYS_TO_SAVE:
        keep_food(use, amount)


def append_entry(date: str, entry: dict):
    ensure_day(date)
    path = day_path(date)
    day = load(path, {})
    day["entries"].append(entry)
    save(path, day)
    recompute_from(date)


# --- portions (target/fit sizing + preview) ------------------------------

def has_target(args) -> bool:
    """Whether a --fit-*/--target-* amount source was requested."""
    return bool(
        args.fit_protein or args.fit_kcal
        or args.target_protein is not None or args.target_kcal is not None
    )


def portion_for_target(name: str, rate: dict, day: dict, args):
    """Amount of a scalable food/batch that meets a --fit-*/--target-* request.
    `rate` is the per-unit macro map (per unit of a food, per whole batch for a
    prep) and `day` is today's snapshot (for the fit gaps). Returns
    (amount, why, dimension, requested); dies on an impossible request."""
    protein_today = sum(e["protein"] for e in day["entries"])
    kcal_today = sum(e["kcal"] for e in day["entries"])
    if args.fit_protein:
        gap = day["proteinGoal"] - protein_today
        if gap <= 0:
            die(f"already at your protein goal today ({round(protein_today)}/{day['proteinGoal']}g)")
        if rate["protein"] <= 0:
            die(f"{name} has no protein to fit to")
        return gap / rate["protein"], "to reach your protein goal", "protein", gap
    if args.fit_kcal:
        gap = day["target"] - kcal_today
        if gap <= 0:
            die(f"already at your kcal target today ({round(kcal_today)}/{day['target']} kcal)")
        if rate["kcal"] <= 0:
            die(f"{name} has no calories to fit to")
        return gap / rate["kcal"], "to reach your kcal target", "kcal", gap
    if args.target_protein is not None:
        if rate["protein"] <= 0:
            die(f"{name} has no protein")
        return args.target_protein / rate["protein"], f"for {r1(args.target_protein)}g protein", "protein", args.target_protein
    if rate["kcal"] <= 0:
        die(f"{name} has no calories")
    return args.target_kcal / rate["kcal"], f"for {round(args.target_kcal)} kcal", "kcal", args.target_kcal


def emit(date: str, entry: dict, *, dry_run: bool, lead: str | None = None, commit=None):
    """Render the day with `entry` applied: on --dry-run project it without
    saving; otherwise `commit()` (which persists) then render the stored day.
    An optional `lead` line (the computed portion) prints first."""
    if lead:
        print(lead)
    if dry_run:
        day = compute_day(date, [entry])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        render_day_dict(day, preview=True)
    else:
        commit()
        render_after_change(date)


# --- rendering -----------------------------------------------------------

def dm(date: str) -> str:
    return f"{date[8:10]}.{date[5:7]}"


def weight_goal():
    """The configured goal weight in kg, or "?" when none is set."""
    return load(GOAL_FILE, {}).get("weightGoal", "?")


def weight_line(day: dict) -> str | None:
    """The day's weigh-in as a standalone summary line, or None when no weight was recorded."""
    w = day.get("weight")
    return f"Weight {w['kg']} kg (goal {weight_goal()})." if w else None


def render_day_dict(day: dict, *, preview: bool = False):
    date = day["date"]
    base = f"Today ({dm(date)})" if date == today() else dm(date)
    label = f"{base} - preview, not logged" if preview else base
    entries = day["entries"]
    protein_goal = day["proteinGoal"]
    if not entries:
        lines = [f"{label}: nothing logged yet.", f"Target: {day['target']} kcal, {protein_goal}g+ protein"]
        weigh_in = weight_line(day)
        if weigh_in:
            lines.append(weigh_in)
        print("\n".join(lines))
        return
    tk = sum(e["kcal"] for e in entries)
    tp = sum(e["protein"] for e in entries)
    tf = sum(e["fat"] for e in entries)
    tc = sum(e["carbs"] for e in entries)
    tomorrow = max(day["dailyGoal"] - day["cumulative"], floor_of(day))
    left = day["target"] - tk

    lines = [f"{label}:", ""]
    for e in entries:
        note = f" [{e['note']}]" if e.get("note") else ""
        lines.append(f"- {e['item']} - {e['kcal']} kcal, {round(e['protein'])}g P{note}")
    kcal_part = f"{round(left)} kcal left" if left >= 0 else f"{round(-left)} kcal over"
    protein_part = "protein hit ✅" if tp >= protein_goal else f"{round(protein_goal - tp)}g protein to go"
    lines += [
        "",
        f"Total: {round(tk)} kcal | {round(tp)}g protein, {round(tf)}g fat, {round(tc)}g carbs",
        f"Target: {day['target']} kcal, {protein_goal}g+ protein",
        f"Left: {kcal_part}, {protein_part}",
    ]
    weigh_in = weight_line(day)
    if weigh_in:
        lines.append(weigh_in)
    lines.append(f"Tomorrow's target: {tomorrow} kcal.")
    print("\n".join(lines))


def render_day(date: str):
    day = compute_day(date)
    if day is None:
        print(f"nothing logged for {date} yet - set a goal first with goal-set")
        return
    render_day_dict(day)


def render_after_change(date: str):
    """Render the changed day; for a past day also render today, since the change
    cascades through the rolling balance and moves today's target."""
    render_day(date)
    if date != today():
        print()
        render_day(today())


# --- commands ------------------------------------------------------------

def cmd_goal(args):
    if not GOAL_FILE.exists():
        die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
    g = load(GOAL_FILE, {})
    print(f"Phase: {g.get('phase')}")
    print(f"TDEE: {g.get('tdee')} kcal")
    print(f"Daily goal: {g.get('dailyGoal')} kcal")
    print(f"Protein: {g.get('proteinGoal')} g")
    weight = g.get("weightGoal")
    print(f"Weight goal: {weight} kg" if weight else "Weight goal: not set")


def cmd_goal_set(args):
    g = load(GOAL_FILE, {})
    for flag, key in (
        ("phase", "phase"), ("tdee", "tdee"), ("daily_goal", "dailyGoal"),
        ("protein", "proteinGoal"), ("weight_goal", "weightGoal"),
    ):
        v = getattr(args, flag)
        if v is not None:
            g[key] = v
    save(GOAL_FILE, g)
    cmd_goal(args)


def cmd_log(args):
    date = args.date or today()
    # No rate behind it: `log` transcribes final macros, which is exactly what "kind": "log" records.
    entry = make_entry(args.time or now_time(), args.item,
                       args.kcal, args.protein, args.fat, args.carbs, args.note,
                       source={"kind": "log"})
    emit(date, entry, dry_run=args.dry_run, commit=lambda: append_entry(date, entry))


def cmd_eat(args):
    """Log a one-off food from a per-100 nutrition label (a photo), scaling it by the amount
    here so that multiplication never happens in-model. Saves nothing by itself; the catalog decides
    that afterwards, from how often the food has been written out."""
    unit = args.unit or "g"
    per100 = {k: getattr(args, f"{k}100") for k in MACROS}
    rate = {k: v / 100 for k, v in per100.items()}
    date = args.date or today()
    why = None
    if has_target(args):
        day = compute_day(date, [])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        amount, why, _, _ = portion_for_target(args.item, rate, day, args)
    elif args.amount is not None:
        amount = args.amount
    else:
        die("give an amount: --amount, --fit-protein/--fit-kcal, or --target-protein/--target-kcal")
    amount = tidy_amount(amount)
    if amount <= 0:
        die("amount must be positive")
    kcal = round(rate["kcal"] * amount)
    protein = r1(rate["protein"] * amount)
    entry = make_entry(now_time(), f"{args.item} ({fmt_amount(amount, unit)})",
                       kcal, protein, r1(rate["fat"] * amount), r1(rate["carbs"] * amount), args.note,
                       source=rate_source("eat", args.item, per100, amount, unit))
    lead = (f"🍽️ {args.item}: {fmt_amount(amount, unit)} {why} - {kcal} kcal, {protein}g P"
            if why else None)
    emit(date, entry, dry_run=args.dry_run, lead=lead, commit=lambda: append_entry(date, entry))
    if not args.dry_run:
        reconcile_catalog(entry["source"], amount, date,
                          use_saved=lambda name: f'food-eat --name "{name}" --amount {amount}')


def cmd_show(args):
    render_day(args.date or today())


def cmd_summary(args):
    end = parse_date(args.to) if args.to else parse_date(today())
    if args.from_:
        start = parse_date(args.from_)
        label_days = None
    elif args.days is not None:
        if args.days < 1:
            die("--days must be >= 1")
        start = end - timedelta(days=args.days - 1)
        label_days = args.days
    else:
        start = end - timedelta(days=6)
        label_days = 7
    if start > end:
        die("range start is after end")

    today_str = today()
    completed = []
    partial = None
    weights = []
    day = start
    while day <= end:
        ds = day.strftime("%Y-%m-%d")
        rec = day_macros(ds)
        if rec is not None:
            if ds == today_str:
                partial = rec["macros"]
            else:
                completed.append(rec)
        kg = day_weight(ds)
        if kg is not None:
            weights.append(kg)
        day += timedelta(days=1)

    span = f"{dm(start.strftime('%Y-%m-%d'))}-{dm(end.strftime('%Y-%m-%d'))}"
    header = f"Last {label_days} day{'s' if label_days != 1 else ''} ({span})" if label_days is not None else span

    if not completed and partial is None and not weights:
        print(f"{header}: nothing logged.")
        return

    lines = [header]
    if completed:
        n = len(completed)
        avg = {k: sum(r["macros"][k] for r in completed) / n for k in MACROS}
        lines.append(
            f"Avg/day over {n} day{'s' if n != 1 else ''}: {round(avg['kcal'])} kcal | "
            f"{round(avg['protein'])}g protein, {round(avg['fat'])}g fat, {round(avg['carbs'])}g carbs"
        )
        extras = []
        if n >= 2:
            kcals = [r["macros"]["kcal"] for r in completed]
            extras.append(f"range {round(min(kcals))}-{round(max(kcals))} kcal/day")
        goaled = [r for r in completed if r["proteinGoal"]]
        if goaled:
            hits = sum(1 for r in goaled if r["macros"]["protein"] >= r["proteinGoal"])
            extras.append(f"protein goal hit {hits}/{len(goaled)} days")
        if extras:
            joined = "; ".join(extras)
            lines.append(joined[0].upper() + joined[1:])
    elif partial is not None:
        lines.append("No complete days logged in this range yet.")
    else:
        lines.append("No food logged in this range.")
    if partial is not None:
        lines.append(
            f"Today so far ({dm(today_str)}): {round(partial['kcal'])} kcal | "
            f"{round(partial['protein'])}g protein, {round(partial['fat'])}g fat, {round(partial['carbs'])}g carbs"
        )
    if weights:
        goal = weight_goal()
        if len(weights) >= 2:
            delta = r1(weights[-1] - weights[0])
            sign = "+" if delta > 0 else ""
            avg_weight = r1(sum(weights) / len(weights))
            lines.append(f"Weight: {weights[0]} → {weights[-1]} kg ({sign}{delta}), avg {avg_weight} (goal {goal})")
        else:
            lines.append(f"Weight: {weights[0]} kg (goal {goal})")
    print("\n".join(lines))


def cmd_weight(args):
    date = args.date or today()
    ensure_day(date)
    day = load(day_path(date), {})
    day["weight"] = {"kg": args.kg, "at": args.at or now_time()}
    save(day_path(date), day)
    render_day(date)


def entry_locked(entry: dict) -> bool:
    """True for a day entry that projects a prep consumption event: it is corrected through
    prep-uneat (unarchiving its batch first if archived), not edited from the day. A batch is
    never deleted, so a prep-sourced entry stays managed by its batch for good."""
    prep_id = (entry.get("source") or {}).get("prepId")
    return bool(prep_id) and prep_id in load(PREP_FILE, {})


def cmd_rm(args):
    date = args.date or today()
    path = day_path(date)
    if not path.exists():
        die(f"nothing logged for {date}")
    day = load(path, {})
    entries = day["entries"]
    if args.last:
        if not entries:
            die(f"nothing logged for {date}")
        idx = len(entries) - 1
    elif args.index is not None:
        idx = args.index - 1
        if not 0 <= idx < len(entries):
            die(f"no entry #{args.index}")
    else:
        die("usage: rm --last | --index N")
    if entry_locked(entries[idx]):
        die("that entry comes from a prep batch - reverse it with prep-uneat, not rm.")
    entries.pop(idx)
    save(path, day)
    recompute_from(date)
    render_after_change(date)


def cmd_entries(args):
    date = args.date or today()
    path = day_path(date)
    entries = load(path, {}).get("entries", []) if path.exists() else []
    if not entries:
        print(f"nothing logged for {date}")
        return
    for i, e in enumerate(entries, 1):
        note = f" [{e['note']}]" if e.get("note") else ""
        print(f"{i}. {e.get('time') or '--:--'}  {e['item']} - "
              f"{e['kcal']} kcal, {round(e['protein'])}g P{note}")


def cmd_edit(args):
    date = args.date or today()
    path = day_path(date)
    if not path.exists():
        die(f"nothing logged for {date}")
    day = load(path, {})
    idx = pick_index(day["entries"], args, "entry")
    entry = day["entries"][idx]
    if entry_locked(entry):
        die("that entry comes from a prep batch - correct it with prep-ingredient-edit "
            "or reverse it with prep-uneat, not edit.")
    changed = False
    # A new amount re-scales from the entry's own rate, so "make that 300g" is a correction rather
    # than a delete-and-retype. Applied first, so any explicit macro passed alongside still wins.
    if args.amount is not None:
        source = entry.get("source") or {}
        per100 = source.get("per100")
        if not per100:
            die("that entry has no per-100 rate to re-scale from - rm it and log it again")
        unit = source.get("unit", "g")
        amount = round(args.amount)
        entry["kcal"] = round(per100["kcal"] / 100 * amount)
        for m in ("protein", "fat", "carbs"):
            entry[m] = r1(per100[m] / 100 * amount)
        entry["item"] = f"{source['name']} ({fmt_amount(amount, unit)})"
        source["amount"] = amount
        changed = True
    for flag in ("item", "kcal", "protein", "fat", "carbs", "note"):
        value = getattr(args, flag)
        if value is not None:
            entry[flag] = value
            changed = True
    if not changed:
        die("give at least one field to change (--amount/--item/--kcal/--protein/--fat/--carbs/--note)")
    save(path, day)
    recompute_from(date)
    render_after_change(date)


def food_line(food: dict) -> str:
    p = food["per100"]
    unit = food.get("unit", "g")
    return (f"{food['name']}: per {fmt_amount(100, unit)} {p['kcal']} kcal, {p['protein']}g P, "
            f"{p['fat']}g F, {p['carbs']}g C; default serving {fmt_amount(food['serving'], unit)}")


def cmd_food_get(args):
    match = find(load(FOOD_FILE, {}), args.query)
    if match.kind == "ambiguous":
        print(f'"{args.query}" matches several: {", ".join(match.candidates)}. Which one?')
        return
    if match.kind == "fuzzy" and len(match.candidates) > 1:
        print(f'no exact match for "{args.query}" - did you mean: {", ".join(match.candidates)}?')
        return
    if match.kind == "none":
        print(f'no saved food matches "{args.query}" - check food-list or estimate it')
        return
    prefix = f'closest to "{args.query}" -> ' if match.kind == "fuzzy" else ""
    print(f"{prefix}{food_line(match.value)}")


def cmd_food_add(args):
    # The catalog keeps what repeats, and keeps it itself (see reconcile_catalog), so the only thing
    # left for this command is a food the user asked for by name. Nothing here can check that claim,
    # which is exactly why it has to be made rather than assumed from the command being run at all:
    # an entry saved on first sight is a guess about the future, and the guesses do not come back.
    if not args.asked:
        die("a saved food is kept for good, so it takes the user's say-so: pass --asked when they "
            "asked for it. A one-off needs no entry - `eat` logs and scales it just the same, and "
            f"the catalog saves it here by itself once the same food has been written out on "
            f"{DAYS_TO_SAVE} separate days, in a meal or as an ingredient.")
    food = load(FOOD_FILE, {})
    key = args.name.lower()
    aliases = [a.strip().lower() for a in (args.aliases or "").split(",") if a.strip()]
    per100 = {"kcal": args.kcal100, "protein": args.protein100, "fat": args.fat100, "carbs": args.carbs100}
    unit = args.unit or "g"
    food[key] = {
        "name": args.name,
        "per100": per100,
        "serving": args.serving,
        "unit": unit,
        "aliases": sorted(set(aliases) | {key}),
        "added": today(),
    }
    save(FOOD_FILE, food)
    announce(f'📌 Saved "{args.name}" to your foods.')
    print(food_line(food[key]))


def food_behind(foods: dict, source: dict, item: str) -> str | None:
    """Which saved food a record is a use of, or None. A record names its food outright, or is the
    same food written out by hand, or - for one made before provenance was recorded - is matched on
    the label the script itself wrote for it ("<name> (<amount>)"), which reconstructs the link rather
    than guessing at it and only misses a food that has been renamed since."""
    kind = source.get("kind")
    if kind == "food":
        return source.get("name")
    if kind == "eat":
        food = saved_food_for(foods, source)
        return food["name"] if food else None
    if not source and item:
        return next((f["name"] for f in foods.values() if item.startswith(f'{f["name"]} (')), None)
    return None


def food_usage(foods: dict) -> dict:
    """On how many days each saved food has been used, and when it last was, per name.

    The catalog records what a food is, never what was done with it, so this is read from the days and
    the batches. Both count: the question a listing answers is whether the food came back, and a
    staple that goes into every batch has come back as surely as a snack that gets eaten. An
    ingredient carries no date of its own, so its batch dates it.

    Days rather than helpings, and the same unit the threshold is measured in, so the listing and the
    saving never answer the same question two ways.
    """
    used = {f["name"]: set() for f in foods.values()}

    def count(named, when):
        if named in used and when:
            used[named].add(when)

    for path in sorted(DAYS_DIR.glob("*.json")) if DAYS_DIR.exists() else []:
        for entry in load(path, {}).get("entries", []):
            count(food_behind(foods, entry.get("source") or {}, entry.get("item") or ""), path.stem)
    for batch in load(PREP_FILE, {}).values():
        for ingredient in batch["ingredients"]:
            count(food_behind(foods, ingredient.get("source") or {}, ""), batch.get("created", ""))
    return {name: {"n": len(days), "last": max(days) if days else None} for name, days in used.items()}


def usage_line(food: dict, seen: dict) -> str:
    """What a saved food has earned, in the terms that decide whether it belongs in the catalog: the
    days it came back on, which is what the threshold counts too."""
    if seen["n"] == 0:
        added = food.get("added")
        return f"never used, saved {dm(added)}" if added else "never used"
    days = "1 day" if seen["n"] == 1 else f"{seen['n']} days"
    return f"{days}, last {dm(seen['last'])}"


def cmd_food_list(args):
    food = load(FOOD_FILE, {})
    if not food:
        print("no foods saved")
        return
    used = food_usage(food)
    # Most used first, so what the catalog is for sits at the top and what it has accumulated sits at
    # the bottom, where it can be dealt with.
    order = sorted(food.values(), key=lambda v: (-used[v["name"]]["n"], v["name"].lower()))
    print(f"{len(order)} saved food(s), most used first:")
    for v in order:
        extra = [a for a in v.get("aliases", []) if a != v["name"].lower()]
        also = f"  \u00b7  {', '.join(extra)}" if extra else ""
        print(f"- {v['name']}  {usage_line(v, used[v['name']])}{also}")


def cmd_food_eat(args):
    _, food, assumed = resolve(load(FOOD_FILE, {}), args.name,
                               noun="saved food", listing="food-list", strict=False)
    per100 = food["per100"]
    unit = food.get("unit", "g")
    rate = {k: per100[k] / 100 for k in MACROS}
    date = args.date or today()
    why = None
    if has_target(args):
        day = compute_day(date, [])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        amount, why, _, _ = portion_for_target(food["name"], rate, day, args)
    elif args.amount is not None:
        amount = args.amount
    elif args.servings is not None:
        amount = args.servings * food["serving"]
    else:
        amount = food["serving"]
    amount = tidy_amount(amount)
    if amount <= 0:
        die("amount must be positive")
    kcal = round(rate["kcal"] * amount)
    protein = r1(rate["protein"] * amount)
    entry = make_entry(now_time(), f"{food['name']} ({fmt_amount(amount, unit)})",
                       kcal, protein, r1(rate["fat"] * amount), r1(rate["carbs"] * amount), None,
                       source=rate_source("food", food["name"], per100, amount, unit))
    leads = []
    if assumed:
        leads.append(f'📝 read "{args.name}" as {assumed}')
    if why:
        leads.append(f"🍽️ {food['name']}: {fmt_amount(amount, unit)} {why} - {kcal} kcal, {protein}g P")
    emit(date, entry, dry_run=args.dry_run, lead="\n".join(leads) or None,
         commit=lambda: append_entry(date, entry))


def cmd_food_edit(args):
    food = load(FOOD_FILE, {})
    key, entry, _ = resolve(food, args.name, noun="saved food", listing="food-list", strict=True)
    for flag, sub in (("kcal100", "kcal"), ("protein100", "protein"), ("fat100", "fat"), ("carbs100", "carbs")):
        value = getattr(args, flag)
        if value is not None:
            entry["per100"][sub] = value
    if args.serving is not None:
        entry["serving"] = args.serving
    if args.unit is not None:
        entry["unit"] = args.unit
    if args.aliases is not None:
        entry["aliases"] = [a.strip().lower() for a in args.aliases.split(",") if a.strip()]
    if args.rename:
        entry["name"] = args.rename
    newkey = entry["name"].lower()
    if newkey != key and newkey in food:
        die(f'a different food is already saved as "{entry["name"]}"')
    entry["aliases"] = sorted(set(entry.get("aliases", [])) | {newkey})
    del food[key]
    food[newkey] = entry
    save(FOOD_FILE, food)
    announce(f'✏️ Updated "{entry["name"]}" in your foods.')
    print(food_line(entry))


def cmd_food_rm(args):
    food = load(FOOD_FILE, {})
    key, entry, _ = resolve(food, args.name, noun="saved food", listing="food-list", strict=True)
    del food[key]
    save(FOOD_FILE, food)
    announce(f'🗑️ Removed "{entry["name"]}" from your foods.')


def zero() -> dict:
    return {k: 0 for k in MACROS}


def macro_add(a: dict, b: dict) -> dict:
    return {k: a[k] + b[k] for k in MACROS}


def macro_sub(a: dict, b: dict) -> dict:
    return {k: a[k] - b[k] for k in MACROS}


def macro_scale(a: dict, f: float) -> dict:
    return {k: a[k] * f for k in MACROS}


def prep_total(batch: dict) -> dict:
    """Whole-batch macros: the sum of its ingredients."""
    out = zero()
    for ingredient in batch["ingredients"]:
        out = macro_add(out, ingredient)
    return out


def consumed(batch: dict, kind: str | None = None) -> dict:
    """Macros that have left the batch, all kinds together or just one
    ("eaten"/"removed"), summed over the consumption event log."""
    out = zero()
    for event in batch["consumption"]:
        if kind is None or event["kind"] == kind:
            out = macro_add(out, event["macros"])
    return out


def prep_remaining(batch: dict) -> dict:
    return macro_sub(prep_total(batch), consumed(batch))


def _frac(part_kcal: float, total_kcal: float) -> float:
    return part_kcal / total_kcal if total_kcal else 0.0


def frac_eaten(batch: dict) -> float:
    return _frac(consumed(batch, "eaten")["kcal"], prep_total(batch)["kcal"])


def frac_removed(batch: dict) -> float:
    return _frac(consumed(batch, "removed")["kcal"], prep_total(batch)["kcal"])


def frac_left(batch: dict) -> float:
    total = prep_total(batch)["kcal"]
    return _frac(total - consumed(batch)["kcal"], total)


# Units written tight against the number (350g); anything wordier gets a space (4 pieces).
TIGHT_UNITS = {"cl", "dl", "g", "kg", "l", "mg", "ml"}


def fmt_amount(amount: float, unit: str) -> str:
    """An amount with its unit. Amounts arrive tidied from the door, so the only ones this has
    anything left to tidy are the ones worked out here - a share of a batch's size."""
    return f"{tidy_amount(amount)}{'' if unit in TIGHT_UNITS else ' '}{unit}"


def portion_size(batch: dict, frac: float) -> str | None:
    """A fraction of the batch as a weight/volume string, or None when no size is set."""
    size = batch.get("size")
    return fmt_amount(size["amount"] * frac, size["unit"]) if size else None


def prep_line(batch: dict) -> str:
    tag = f" \u00b7 archived {dm(batch['archivedAt'])}" if batch.get("archivedAt") else ""
    if not batch["ingredients"]:
        return f"{batch['name']}: empty (no ingredients yet){tag}"
    rem = prep_remaining(batch)
    size = portion_size(batch, frac_left(batch))
    size_txt = f"{size}, " if size else ""
    return (f"{batch['name']}: {round(frac_left(batch) * 100)}% left "
            f"({size_txt}{round(rem['kcal'])} kcal, {r1(rem['protein'])}g P){tag}")


def portion_desc(batch: dict, frac: float, left: float) -> str:
    """How a portion reads to the user: its share of what's currently left (the actionable
    framing) plus, in parentheses, its share of the whole batch and its size. Before anything
    has been eaten the two shares coincide, so only the whole-batch one is shown. `left` is the
    remaining fraction before this portion, passed in so callers that have already mutated the
    batch still describe it against the pre-consumption state."""
    of_whole = round(frac * 100)
    size = portion_size(batch, frac)
    if 0 < left < 1 - 1e-6:
        size_txt = f", ~{size}" if size else ""
        return f"{round(frac / left * 100)}% of what's left ({of_whole}% of batch{size_txt})"
    size_txt = f" (~{size})" if size else ""
    return f"{of_whole}% of batch{size_txt}"


def explicit_share(args, batch: dict, left: float):
    """The share of the *whole* batch an explicitly named portion comes to, or None when none was
    named (leaving prep-eat's --fit-*/--target-* to size it instead).

    Every way of naming a portion converts here, because a share means nothing without its
    denominator and picking between them is the one thing that must not happen in the caller's head:
    --of-rest is a share of what is left, --of-batch a share of everything that was made, --size an
    absolute amount of a batch whose size is known. The flags name their denominator, so there is
    nothing to infer and nothing to convert before calling.
    """
    if args.size is not None:
        if not batch.get("size"):
            die(f'"{batch["name"]}" has no size set - set one with prep-size, or name a share '
                "with --of-rest/--of-batch")
        return args.size / batch["size"]["amount"]
    if args.of_rest is not None:
        return rest_fraction(args.of_rest) * left
    if args.of_batch is not None:
        frac = parse_fraction(args.of_batch)
        # The two denominators only diverge once a batch is partly gone, which is exactly where
        # choosing the wrong one is silent. Saying what this share is of the rest puts the other
        # reading in front of the caller while it can still be corrected.
        if 0 < left < 1 - 1e-6:
            hint(f'[macros] {batch["name"]} is {round(left * 100)}% left, so --of-batch '
                 f"{args.of_batch} is {round(frac / left * 100)}% of what's left. If that share was "
                 "meant of the leftovers, --of-rest says so and works it out here.")
        return frac
    return None


def remaining_note(batch: dict, frac: float, left: float, *, dry_run: bool) -> str:
    """The batch's remaining share before and after taking `frac` of the whole - the one place
    prep-eat surfaces how much is left, phrased as a projection on a dry run."""
    before, after = round(left * 100), round(max(left - frac, 0) * 100)
    if dry_run:
        return f"🥘 {batch['name']}: {before}% left now, {after}% if eaten"
    return f"🥘 {batch['name']}: {before}% → {after}% left"


def make_event(kind: str, date: str, macros: dict, label: str) -> dict:
    """One consumption event: a portion that left the batch, eaten (logged to your day)
    or removed (unlogged). Macros are snapshotted, so past days never shift under it.

    They are also the one thing here left unrounded, because they are shares of a whole rather than
    figures in their own right: they have to sum back to the batch, and rounded thirds of an 1801
    kcal batch leave 0.06% of it behind - enough to stop a finished batch archiving itself. Every
    reader rounds them, and the day entry a portion produces is rounded on its way out."""
    return {
        "id": secrets.token_hex(4), "kind": kind, "date": date, "time": now_time(),
        "macros": {k: macros[k] for k in MACROS}, "label": label,
    }


def apply_delta(batch: dict, key: str, delta: dict, *, date: str, label: str, verb: str,
                leads: list, log_eaten: bool):
    """Fold a composition change into the consumption log by how much has already left
    the batch: the eaten fraction of `delta` becomes an eaten adjustment event (your
    intake), the removed fraction a removed one, the rest is just composition (it flows
    to remaining). Call *before* the ingredient list is mutated, so `total` is read
    pre-change. When `log_eaten`, the eaten share is also posted to `date` as a linked
    prep-fix entry. Every event stays inspectable and reversible with prep-uneat."""
    total = prep_total(batch)["kcal"]
    mine = macro_scale(delta, _frac(consumed(batch, "eaten")["kcal"], total))
    others = macro_scale(delta, _frac(consumed(batch, "removed")["kcal"], total))
    if any(abs(mine[k]) > 1e-9 for k in MACROS):
        event = make_event("eaten", date, mine, f"{label} ({verb} share)")
        batch["consumption"].append(event)
        kcal = round(mine["kcal"])
        if log_eaten and kcal != 0:
            append_entry(date, make_entry(
                now_time(), f"{batch['name']} - {verb} {label} (already-eaten share)",
                kcal, r1(mine["protein"]), r1(mine["fat"]), r1(mine["carbs"]), "prep-fix",
                source={"kind": "prep", "prepId": key, "eventId": event["id"]}))
            leads.append(f"logged the {kcal} kcal you'd already eaten from it (today)" if kcal > 0
                         else f"un-logged the {-kcal} kcal of it you'd already eaten (today)")
    if any(abs(others[k]) > 1e-9 for k in MACROS):
        batch["consumption"].append(make_event("removed", date, others, f"{label} ({verb} share)"))


def pick_index(items: list, args, noun: str) -> int:
    """0-based index into `items` from --last / --index N (1-based)."""
    if getattr(args, "last", False):
        if not items:
            die(f"no {noun} to select")
        return len(items) - 1
    if args.index is not None:
        i = args.index - 1
        if not 0 <= i < len(items):
            die(f"no {noun} #{args.index}")
        return i
    die("give --last or --index N")


def prep_size_from_args(args) -> dict | None:
    return {"amount": args.size, "unit": args.unit or "g"} if getattr(args, "size", None) is not None else None


def live_preps(prep: dict) -> dict:
    """Batches still in play (not archived). Every acting verb resolves names over these, so
    there is at most one match per name - a finished batch archives itself and steps aside."""
    return {k: v for k, v in prep.items() if v.get("archivedAt") is None}


def archived_preps(prep: dict) -> dict:
    return {k: v for k, v in prep.items() if v.get("archivedAt") is not None}


def new_prep_id(prep: dict) -> str:
    while True:
        candidate = secrets.token_hex(4)
        if candidate not in prep:
            return candidate


def live_named(prep: dict, name: str) -> dict | None:
    """The live batch of this name (case-insensitive), or None - the guard behind one live
    batch per name."""
    q = name.lower().strip()
    return next((b for b in live_preps(prep).values() if b["name"].lower() == q), None)


def maybe_archive(batch: dict):
    """A batch eaten or given down to nothing files itself away: kept for lookup, out of the
    active set. Reopen with prep-unarchive to correct the final portion."""
    if batch.get("archivedAt") is None and prep_total(batch)["kcal"] > 0 and frac_left(batch) <= 0.0001:
        batch["archivedAt"] = today()


def match_by_name(mapping: dict, query: str) -> list:
    q = query.lower().strip()
    return [(k, v) for k, v in mapping.items() if q and any(q in label for label in labels_of(k, v))]


def archived_choice(hits: list) -> str:
    """A pick-one list of archived candidates, newest first, each tagged with its id."""
    ordered = sorted(hits, key=lambda kv: kv[1].get("archivedAt") or "", reverse=True)
    return ", ".join(f'{v["name"]} (archived {dm(v["archivedAt"])}, id {k})' for k, v in ordered)


def resolve_prep_lookup(prep: dict, query: str) -> tuple:
    """Resolve a name for inspection: prefer the live batch, else archived history (a lone
    match wins; several same-name archived batches need --id). Returns (id, batch)."""
    live = find(live_preps(prep), query)
    if live.kind in ("exact", "substring") or (live.kind == "fuzzy" and len(live.candidates) == 1):
        return live.key, live.value
    hits = match_by_name(archived_preps(prep), query)
    if len(hits) == 1:
        return hits[0]
    if hits:
        die(f'several archived preps match "{query}": {archived_choice(hits)}. Re-run prep-get with --id.')
    die(f'no prep matches "{query}" - check prep-list --all.')


def cmd_prep_add(args):
    prep = load(PREP_FILE, {})
    active = live_named(prep, args.name)
    if active is not None:
        die(f'a prep called "{active["name"]}" is already active ({round(frac_left(active) * 100)}% left) - '
            f"add to it with prep-ingredient-add, or prep-archive it first.")
    key = new_prep_id(prep)
    size = prep_size_from_args(args)
    prep[key] = {"id": key, "name": args.name, "created": today(), "archivedAt": None,
                 "size": size, "ingredients": [], "consumption": []}
    save(PREP_FILE, prep)
    size_txt = f", {fmt_amount(size['amount'], size['unit'])}" if size else ""
    print(f"created prep: {args.name}{size_txt} (empty - add ingredients with prep-ingredient-add)")


def cmd_prep_size(args):
    prep = load(PREP_FILE, {})
    _, batch, assumed = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=False)
    if assumed:
        print(f'📝 read "{args.name}" as {assumed}')
    if args.clear:
        batch["size"] = None
        save(PREP_FILE, prep)
        print(f"cleared the size of {batch['name']}")
        return
    batch["size"] = {"amount": args.size, "unit": args.unit or "g"}
    save(PREP_FILE, prep)
    print(f"set {batch['name']} size to {fmt_amount(args.size, args.unit or 'g')}")
    print(prep_line(batch))


def scaled_ingredient(label: str, per100: dict, amount, unit: str, kind: str, name: str) -> dict:
    """An ingredient weighed out against a per-100 rate, scaled here and labelled with what went in.
    Its rate is snapshotted the way a day entry's is, so "make that 500g" stays one flag later."""
    rate = {k: per100[k] / 100 for k in MACROS}
    return {
        "label": f"{label} ({fmt_amount(amount, unit)})",
        "kcal": round(rate["kcal"] * amount),
        "protein": r1(rate["protein"] * amount),
        "fat": r1(rate["fat"] * amount),
        "carbs": r1(rate["carbs"] * amount),
        "source": rate_source(kind, name, per100, amount, unit),
    }


def ingredient_from(args) -> tuple:
    """(ingredient, assumed) for a new ingredient, from whichever way its numbers arrived.

    Three ways in, because that is how they arrive: a saved food and how much of it went in, a label's
    per-100 rate and how much went in, or the final macros when there is no rate behind them. The two
    scaled forms are the same grammar `eat` uses and are worked out here, so an ingredient weighed off
    a packet is never multiplied out first. `assumed` is the food name to announce when one was
    matched loosely.
    """
    if args.food is not None:
        if args.amount is None:
            die("give --amount as well: how much of the food went in, in its own unit")
        _, food, assumed = resolve(load(FOOD_FILE, {}), args.food,
                                   noun="saved food", listing="food-list", strict=False)
        return scaled_ingredient(args.label or food["name"], food["per100"], args.amount,
                                 food.get("unit", "g"), "food", food["name"]), assumed
    if args.kcal100 is not None:
        if args.amount is None:
            die("give --amount as well: how much of it went in")
        if not args.label:
            die("give --label as well: what to call the ingredient")
        per100 = {k: getattr(args, f"{k}100") for k in MACROS}
        return scaled_ingredient(args.label, per100, args.amount, args.unit or "g",
                                 "eat", args.label), None
    if args.kcal is None:
        die("give the ingredient's macros: --food NAME --amount N for something saved, "
            "--kcal100 N --amount N off a packet, or --kcal N when you only have the total")
    if not args.label:
        die("give --label as well: what to call the ingredient")
    return {"label": args.label, "kcal": args.kcal, "protein": args.protein, "fat": args.fat,
            "carbs": args.carbs, "source": {"kind": "log"}}, None


def cmd_prep_ingredient_add(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=False)
    ingredient, food_assumed = ingredient_from(args)
    label = ingredient["label"]
    date = args.date or today()
    # A --later ingredient went into the leftovers only: all of it flows to remaining and
    # nothing is attributed to what already left. A forgotten one (the default) was in the
    # whole batch, so apply_delta books its already-consumed share as adjustment events
    # (the eaten share also lands on your day). Before anything is consumed the two
    # coincide. apply_delta runs before the append, so `total` excludes the new ingredient.
    consumed_any = frac_eaten(batch) + frac_removed(batch) > 0
    forgotten = consumed_any and not args.later
    mode = " (to the leftovers)" if (args.later and consumed_any) else (
        " (forgotten - was in the whole batch)" if forgotten else "")

    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    if food_assumed:
        leads.append(f'📝 read "{args.food}" as {food_assumed}')
    leads.append(f"added to {batch['name']}{mode}: {label} - "
                 f"{round(ingredient['kcal'])} kcal, {r1(ingredient['protein'])}g P")
    if forgotten:
        apply_delta(batch, key, ingredient, date=date, label=label, verb="forgotten",
                    leads=leads, log_eaten=not args.no_log_eaten)
    batch["ingredients"].append(ingredient)
    save(PREP_FILE, prep)
    leads.append(prep_line(batch))
    print("\n".join(leads))
    # An ingredient weighed out from a rate is that rate written out by hand, exactly as a one-off
    # meal is, so it counts the same. Reconciled after the save, so the ingredient just added is part
    # of the count, and after the report, so a save reads as news under it.
    source = ingredient.get("source") or {}
    if source.get("kind") == "eat":
        reconcile_catalog(
            source, source["amount"], date,
            use_saved=lambda name: (f'prep-ingredient-add --name "{batch["name"]}" '
                                    f'--food "{name}" --amount {source["amount"]}'),
        )


def cmd_prep_ingredient_edit(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=False)
    idx = pick_index(batch["ingredients"], args, "ingredient")
    ingredient = batch["ingredients"][idx]
    old = {k: ingredient[k] for k in MACROS}
    new = dict(old)
    # A new amount re-scales from the ingredient's own rate and relabels it, so "make that 500g" is
    # one flag rather than four. Applied first, so any explicit macro passed alongside still wins.
    relabel = None
    if args.amount is not None:
        source = ingredient.get("source") or {}
        per100 = source.get("per100")
        if not per100:
            die("that ingredient has no per-100 rate to re-scale from - give its macros instead")
        rate = {k: per100[k] / 100 for k in MACROS}
        new["kcal"] = round(rate["kcal"] * args.amount)
        for m in ("protein", "fat", "carbs"):
            new[m] = r1(rate[m] * args.amount)
        relabel = f"{source['name']} ({fmt_amount(args.amount, source.get('unit', 'g'))})"
        source["amount"] = args.amount
    for m in MACROS:
        value = getattr(args, m)
        if value is not None:
            new[m] = value
    label = args.label or relabel or ingredient["label"]
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    leads.append(f"updated {batch['name']} ingredient {idx + 1}: {label} - "
                 f"{round(new['kcal'])} kcal, {r1(new['protein'])}g P")
    # Correct the macro delta like a forgotten add; computed before the ingredient is
    # updated, so `total` still reflects the old values.
    apply_delta(batch, key, macro_sub(new, old), date=args.date or today(), label=label,
                verb="corrected", leads=leads, log_eaten=not args.no_log_eaten)
    ingredient.update(new)
    ingredient["label"] = label
    save(PREP_FILE, prep)
    leads.append(prep_line(batch))
    print("\n".join(leads))


def cmd_prep_ingredient_rm(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=False)
    idx = pick_index(batch["ingredients"], args, "ingredient")
    ingredient = batch["ingredients"][idx]
    label, kcal = ingredient["label"], round(ingredient["kcal"])
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    leads.append(f"removed from {batch['name']}: {label} ({kcal} kcal)")
    # A removal is a negative delta, corrected in reverse; computed before dropping the
    # ingredient so `total` still includes it.
    apply_delta(batch, key, macro_scale({k: ingredient[k] for k in MACROS}, -1),
                date=args.date or today(), label=label, verb="removed",
                leads=leads, log_eaten=not args.no_log_eaten)
    batch["ingredients"].pop(idx)
    save(PREP_FILE, prep)
    leads.append(prep_line(batch))
    print("\n".join(leads))


def cmd_prep_get(args):
    prep = load(PREP_FILE, {})
    if getattr(args, "id", None):
        batch = prep.get(args.id)
        if batch is None:
            die(f'no prep with id "{args.id}" - see prep-list --all')
    elif args.name:
        _, batch = resolve_prep_lookup(prep, args.name)
    else:
        die("give --name or --id")
    size = batch.get("size")
    size_txt = f", {fmt_amount(size['amount'], size['unit'])}" if size else ""
    state = f" \u00b7 archived {dm(batch['archivedAt'])}" if batch.get("archivedAt") else ""
    print(f"{batch['name']} ({dm(batch['created'])}){size_txt}{state} \u00b7 id {batch['id']}:")
    if not batch["ingredients"]:
        print("  empty - no ingredients yet")
    for i, ingredient in enumerate(batch["ingredients"], 1):
        print(f"{i}. {ingredient['label']} - {ingredient['kcal']} kcal, {r1(ingredient['protein'])}g P, "
              f"{r1(ingredient['fat'])}g F, {r1(ingredient['carbs'])}g C")
    total = prep_total(batch)
    print(f"Total: {round(total['kcal'])} kcal, {r1(total['protein'])}g P, "
          f"{r1(total['fat'])}g F, {r1(total['carbs'])}g C")
    if not batch["ingredients"]:
        return
    if batch["consumption"]:
        print("Consumption:")
        for i, event in enumerate(batch["consumption"], 1):
            frac = _frac(event["macros"]["kcal"], total["kcal"])
            size_part = f", {portion_size(batch, frac)}" if size else ""
            verb = "ate" if event["kind"] == "eaten" else "removed"
            tag = "" if event["kind"] == "eaten" else " [unlogged]"
            print(f"{i}. {dm(event['date'])} {event['time']} - {verb} {round(frac * 100)}%"
                  f"{size_part} ({round(event['macros']['kcal'])} kcal){tag}")
    rem = prep_remaining(batch)
    fr = frac_removed(batch)
    split = f" - you {round(frac_eaten(batch) * 100)}%, others {round(fr * 100)}%" if fr > 0.0001 else ""
    left_size = portion_size(batch, frac_left(batch))
    left_txt = f"{left_size}, " if left_size else ""
    print(f"Left: {round(frac_left(batch) * 100)}% ({left_txt}{round(rem['kcal'])} kcal, "
          f"{r1(rem['protein'])}g P){split}")


def cmd_prep_eat(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=False)
    total = prep_total(batch)
    if total["kcal"] <= 0:
        die(f'"{batch["name"]}" has no ingredients yet - add some with prep-ingredient-add')
    left = frac_left(batch)
    date = args.date or today()
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    capped = False
    # A named share resolves in explicit_share, which owns the denominators; --fit-*/--target-* size
    # the share from the day instead.
    if has_target(args):
        day = compute_day(date, [])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        ideal, why, dim, requested = portion_for_target(batch["name"], total, day, args)
        frac = min(ideal, left)
        capped = ideal > left + 1e-6
    else:
        frac = explicit_share(args, batch, left)
    if frac is None:
        die("give an amount: --of-rest [frac], --of-batch <frac>, --size, --fit-protein/--fit-kcal, "
            "or --target-protein/--target-kcal")
    if frac <= 0:
        die("amount must be positive")
    # An explicit over-ask is a mistake; a fit/target over-ask is capped above.
    if not has_target(args) and frac > left + 1e-6:
        die(f'only {round(left * 100)}% of "{batch["name"]}" is left '
            f"({round(total['kcal'] * left)} kcal); cannot eat "
            f"{round(frac * 100)}%. Use --of-rest to finish it.")
    portion = macro_scale(total, frac)
    size_part = portion_size(batch, frac)
    item = f"{batch['name']} ({round(frac * 100)}% of batch{f', {size_part}' if size_part else ''})"
    entry = make_entry(now_time(), item, round(portion["kcal"]), r1(portion["protein"]),
                       r1(portion["fat"]), r1(portion["carbs"]), "prep",
                       source={"kind": "prep", "prepId": key})
    partial = 0 < left < 1 - 1e-6
    # The portion line is worth showing for a fit/target portion (always) or any portion of an
    # already-partial batch (where "of what's left" adds real info); on a full batch a plain
    # portion just repeats the day-summary label, so it's skipped there.
    if has_target(args) or partial:
        why_txt = f"{why} " if has_target(args) else ""
        leads.append(f"🍽️ {batch['name']}: {portion_desc(batch, frac, left)} {why_txt}- "
                     f"{round(portion['kcal'])} kcal, {r1(portion['protein'])}g P")
    # The batch's remaining is stated on every eat, so no reply (least of all a --dry-run) ever
    # leaves it unclear how full the batch is. A capped fit/target already says it in its warning.
    if has_target(args) and capped:
        short = requested - portion[dim]
        short_txt = f"{round(short)}g P" if dim == "protein" else f"{round(short)} kcal"
        leads.append(f"⚠️ only {round(left * 100)}% of the batch is left - "
                     f"capped to that, {short_txt} short of the target.")
    else:
        leads.append(remaining_note(batch, frac, left, dry_run=args.dry_run))
    if total["kcal"] > 0 and left - frac <= 1e-6:
        leads.append("\U0001f5c4\ufe0f that would finish and archive the batch (kept in prep-list --all)"
                     if args.dry_run else
                     "\U0001f5c4\ufe0f batch finished - archived (still in prep-list --all)")

    def commit():
        event = make_event("eaten", date, portion, f"{round(frac * 100)}% of batch")
        append_entry(date, make_entry(now_time(), item, round(portion["kcal"]), r1(portion["protein"]),
                                      r1(portion["fat"]), r1(portion["carbs"]), "prep",
                                      source={"kind": "prep", "prepId": key, "eventId": event["id"]}))
        batch["consumption"].append(event)
        maybe_archive(batch)
        prep[key] = batch
        save(PREP_FILE, prep)

    emit(date, entry, dry_run=args.dry_run, lead="\n".join(leads) or None, commit=commit)


def cmd_prep_remove(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=False)
    total = prep_total(batch)
    if total["kcal"] <= 0:
        die(f'"{batch["name"]}" has no ingredients yet')
    left = frac_left(batch)
    frac = explicit_share(args, batch, left)
    if frac is None:
        die("give an amount: --of-rest [frac], --of-batch <frac>, or --size")
    if frac <= 0:
        die("amount must be positive")
    if frac > left + 1e-6:
        die(f'only {round(left * 100)}% of "{batch["name"]}" is left; cannot remove {round(frac * 100)}%. '
            f"Use --of-rest to clear the rest.")
    portion = macro_scale(total, frac)
    batch["consumption"].append(make_event("removed", args.date or today(), portion, "unlogged"))
    maybe_archive(batch)
    prep[key] = batch
    save(PREP_FILE, prep)
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    extra = f"{round(frac / left * 100)}% of what was left; " if 0 < left < 1 - 1e-6 else ""
    leads.append(f"removed {round(frac * 100)}% of {batch['name']} ({extra}unlogged - not your intake)")
    if batch.get("archivedAt"):
        leads.append("\U0001f5c4\ufe0f that empties the batch - archived (still in prep-list --all)")
    leads.append(prep_line(batch))
    print("\n".join(leads))


def remove_linked_entry(event: dict, dates: set):
    """Drop the day entry that projects `event`, noting its date for a ledger refresh."""
    path = day_path(event["date"])
    if not path.exists():
        return
    day = load(path, {})
    kept = [e for e in day["entries"] if (e.get("source") or {}).get("eventId") != event["id"]]
    if len(kept) != len(day["entries"]):
        day["entries"] = kept
        save(path, day)
        dates.add(event["date"])


def cmd_prep_uneat(args):
    prep = load(PREP_FILE, {})
    key, batch, _ = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=True)
    events = batch["consumption"]
    if not events:
        die(f'nothing has been eaten or removed from "{batch["name"]}" yet')
    if args.all:
        targets = list(events)
        batch["consumption"] = []
    else:
        targets = [events.pop(pick_index(events, args, "consumption event"))]
    dates: set = set()
    for event in targets:
        if event["kind"] == "eaten":
            remove_linked_entry(event, dates)
    prep[key] = batch
    save(PREP_FILE, prep)
    if dates:
        recompute_from(min(dates))

    if args.all:
        back = round(sum(e["macros"]["kcal"] for e in targets))
        head = (f"reversed all consumption of {batch['name']} "
                f"({len(targets)} event(s), {back} kcal back to remaining)")
    else:
        event = targets[0]
        verb = "eaten" if event["kind"] == "eaten" else "removed"
        head = f"reversed a {round(event['macros']['kcal'])} kcal {verb} portion of {batch['name']}"
    lines = [head]
    if dates:
        lines.append("un-logged the linked day entr" + ("ies" if len(dates) > 1 else "y")
                     + " and recomputed the ledger")
    lines.append(prep_line(batch))
    print("\n".join(lines))


def cmd_prep_list(args):
    prep = load(PREP_FILE, {})
    shown = [b for b in prep.values() if args.all or b.get("archivedAt") is None]
    if not shown:
        print("no active preps" if prep else "no preps saved")
        return
    for b in shown:
        print(f"- {prep_line(b)}")


def cmd_prep_archive(args):
    prep = load(PREP_FILE, {})
    _, batch, _ = resolve(live_preps(prep), args.name, noun="active prep", listing="prep-list", strict=True)
    batch["archivedAt"] = today()
    save(PREP_FILE, prep)
    print(f"archived {batch['name']} (was {round(frac_left(batch) * 100)}% left) - kept, see prep-list --all")


def cmd_prep_unarchive(args):
    prep = load(PREP_FILE, {})
    if getattr(args, "id", None):
        batch = archived_preps(prep).get(args.id)
        if batch is None:
            die(f'no archived prep with id "{args.id}" - see prep-list --all')
    elif args.name:
        hits = match_by_name(archived_preps(prep), args.name)
        if not hits:
            die(f'no archived prep matches "{args.name}" - see prep-list --all')
        if len(hits) > 1:
            die(f'several archived preps match "{args.name}": {archived_choice(hits)}. Re-run with --id.')
        batch = hits[0][1]
    else:
        die("give --name or --id")
    clash = live_named(prep, batch["name"])
    if clash is not None:
        die(f'a prep named "{batch["name"]}" is already active - archive it before reopening this one.')
    batch["archivedAt"] = None
    save(PREP_FILE, prep)
    print(f"reopened {batch['name']} ({round(frac_left(batch) * 100)}% left)")


def cmd_recompute(args):
    days = sorted(p.stem for p in DAYS_DIR.glob("*.json")) if DAYS_DIR.exists() else []
    n = 0
    for d in days:
        if len(d) == 10 and (args.from_ is None or d >= args.from_):
            refresh_ledger(d)
            n += 1
    print(f"recomputed {n} day(s)")


def add_amount_flags(sp, *extra):
    """Attach the mutually exclusive amount sources (command-specific `extra`
    plus the shared --fit-*/--target-*) and the --dry-run/--date flags."""
    group = sp.add_mutually_exclusive_group()
    for name, kwargs in extra:
        group.add_argument(name, **kwargs)
    group.add_argument("--fit-protein", action="store_true")
    group.add_argument("--fit-kcal", action="store_true")
    group.add_argument("--target-protein", type=TENTH_POSITIVE)
    group.add_argument("--target-kcal", type=WHOLE_POSITIVE)
    sp.add_argument("--dry-run", action="store_true")
    sp.add_argument("--date")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="macros.py", description="daily nutrition tracker")
    sub = p.add_subparsers(dest="cmd", required=True)

    # Every command's audience is settled here, not per run: `delivers` marks the ones whose output
    # is written for the user, which is all of them but the ledger repair - every number this script
    # prints is a record it keeps on their behalf, so it is never read or changed out of their sight.
    def command(name: str, *, delivers: bool = True) -> argparse.ArgumentParser:
        parser = sub.add_parser(name)
        parser.set_defaults(delivers=delivers)
        return parser

    command("goal").set_defaults(func=cmd_goal)

    g = command("goal-set")
    g.set_defaults(func=cmd_goal_set)
    g.add_argument("--phase", choices=["cut", "maintenance", "bulk"])
    g.add_argument("--tdee", type=WHOLE_POSITIVE)
    g.add_argument("--daily-goal", type=WHOLE_POSITIVE)
    g.add_argument("--protein", type=TENTH_POSITIVE)
    g.add_argument("--weight-goal", type=TENTH_POSITIVE)

    lo = command("log")
    lo.set_defaults(func=cmd_log)
    lo.add_argument("--item", required=True)
    lo.add_argument("--kcal", type=WHOLE, required=True)
    lo.add_argument("--protein", type=TENTH, default=0)
    lo.add_argument("--fat", type=TENTH, default=0)
    lo.add_argument("--carbs", type=TENTH, default=0)
    lo.add_argument("--note")
    lo.add_argument("--time")
    lo.add_argument("--date")
    lo.add_argument("--dry-run", action="store_true")

    ea = command("eat")
    ea.set_defaults(func=cmd_eat)
    ea.add_argument("--item", required=True)
    ea.add_argument("--kcal100", type=WHOLE, required=True)
    ea.add_argument("--protein100", type=TENTH, default=0)
    ea.add_argument("--fat100", type=TENTH, default=0)
    ea.add_argument("--carbs100", type=TENTH, default=0)
    ea.add_argument("--unit")
    ea.add_argument("--note")
    add_amount_flags(ea, ("--amount", {"type": AMOUNT}))

    sh = command("show")
    sh.set_defaults(func=cmd_show)
    sh.add_argument("--date")

    sm = command("summary")
    sm.set_defaults(func=cmd_summary)
    grp = sm.add_mutually_exclusive_group()
    grp.add_argument("--days", type=int)
    grp.add_argument("--from", dest="from_")
    sm.add_argument("--to")

    w = command("weight")
    w.set_defaults(func=cmd_weight)
    w.add_argument("--kg", type=TENTH_POSITIVE, required=True)
    w.add_argument("--at")
    w.add_argument("--date")

    rm = command("rm")
    rm.set_defaults(func=cmd_rm)
    rm.add_argument("--last", action="store_true")
    rm.add_argument("--index", type=int)
    rm.add_argument("--date")

    en = command("entries")
    en.set_defaults(func=cmd_entries)
    en.add_argument("--date")

    ed = command("edit")
    ed.set_defaults(func=cmd_edit)
    ed.add_argument("--last", action="store_true")
    ed.add_argument("--index", type=int)
    ed.add_argument("--amount", type=AMOUNT)
    ed.add_argument("--item")
    ed.add_argument("--kcal", type=WHOLE)
    ed.add_argument("--protein", type=TENTH)
    ed.add_argument("--fat", type=TENTH)
    ed.add_argument("--carbs", type=TENTH)
    ed.add_argument("--note")
    ed.add_argument("--date")

    fg = command("food-get")
    fg.set_defaults(func=cmd_food_get)
    fg.add_argument("query")

    fa = command("food-add")
    fa.set_defaults(func=cmd_food_add)
    fa.add_argument("--name", required=True)
    fa.add_argument("--kcal100", type=WHOLE, required=True)
    fa.add_argument("--protein100", type=TENTH, required=True)
    fa.add_argument("--fat100", type=TENTH, required=True)
    fa.add_argument("--carbs100", type=TENTH, required=True)
    fa.add_argument("--serving", type=AMOUNT, required=True)
    fa.add_argument("--unit")
    fa.add_argument("--aliases")
    fa.add_argument("--asked", action="store_true",
                    help="the user asked for this food to be saved (required)")

    command("food-list").set_defaults(func=cmd_food_list)

    fe = command("food-eat")
    fe.set_defaults(func=cmd_food_eat)
    fe.add_argument("--name", required=True)
    add_amount_flags(fe, ("--amount", {"type": AMOUNT}), ("--servings", {"type": AMOUNT}))

    fed = command("food-edit")
    fed.set_defaults(func=cmd_food_edit)
    fed.add_argument("--name", required=True)
    fed.add_argument("--kcal100", type=WHOLE)
    fed.add_argument("--protein100", type=TENTH)
    fed.add_argument("--fat100", type=TENTH)
    fed.add_argument("--carbs100", type=TENTH)
    fed.add_argument("--serving", type=AMOUNT)
    fed.add_argument("--unit")
    fed.add_argument("--rename")
    fed.add_argument("--aliases")

    frm = command("food-rm")
    frm.set_defaults(func=cmd_food_rm)
    frm.add_argument("--name", required=True)

    pa = command("prep-add")
    pa.set_defaults(func=cmd_prep_add)
    pa.add_argument("--name", required=True)
    pa.add_argument("--size", type=AMOUNT)
    pa.add_argument("--unit")

    psz = command("prep-size")
    psz.set_defaults(func=cmd_prep_size)
    psz.add_argument("--name", required=True)
    grp = psz.add_mutually_exclusive_group(required=True)
    grp.add_argument("--size", type=AMOUNT)
    grp.add_argument("--clear", action="store_true")
    psz.add_argument("--unit")

    ping = command("prep-ingredient-add")
    ping.set_defaults(func=cmd_prep_ingredient_add)
    ping.add_argument("--name", required=True)
    ping.add_argument("--label")
    # One rate basis per ingredient: a saved food, a packet's per-100, or the total typed out.
    basis = ping.add_mutually_exclusive_group()
    basis.add_argument("--food")
    basis.add_argument("--kcal100", type=WHOLE)
    basis.add_argument("--kcal", type=WHOLE)
    ping.add_argument("--amount", type=AMOUNT)
    ping.add_argument("--unit")
    ping.add_argument("--protein100", type=TENTH, default=0)
    ping.add_argument("--fat100", type=TENTH, default=0)
    ping.add_argument("--carbs100", type=TENTH, default=0)
    ping.add_argument("--protein", type=TENTH, default=0)
    ping.add_argument("--fat", type=TENTH, default=0)
    ping.add_argument("--carbs", type=TENTH, default=0)
    ping.add_argument("--later", action="store_true")
    ping.add_argument("--no-log-eaten", action="store_true")
    ping.add_argument("--date")

    pied = command("prep-ingredient-edit")
    pied.set_defaults(func=cmd_prep_ingredient_edit)
    pied.add_argument("--name", required=True)
    pied.add_argument("--last", action="store_true")
    pied.add_argument("--index", type=int)
    pied.add_argument("--amount", type=AMOUNT)
    pied.add_argument("--label")
    pied.add_argument("--kcal", type=WHOLE)
    pied.add_argument("--protein", type=TENTH)
    pied.add_argument("--fat", type=TENTH)
    pied.add_argument("--carbs", type=TENTH)
    pied.add_argument("--no-log-eaten", action="store_true")
    pied.add_argument("--date")

    pirm = command("prep-ingredient-rm")
    pirm.set_defaults(func=cmd_prep_ingredient_rm)
    pirm.add_argument("--name", required=True)
    pirm.add_argument("--last", action="store_true")
    pirm.add_argument("--index", type=int)
    pirm.add_argument("--no-log-eaten", action="store_true")
    pirm.add_argument("--date")

    pget = command("prep-get")
    pget.set_defaults(func=cmd_prep_get)
    pget.add_argument("--name")
    pget.add_argument("--id")

    pe = command("prep-eat")
    pe.set_defaults(func=cmd_prep_eat)
    pe.add_argument("--name", required=True)
    add_amount_flags(pe, ("--of-rest", {"nargs": "?", "const": "1", "default": None}),
                     ("--of-batch", {}), ("--size", {"type": AMOUNT}))

    prem = command("prep-remove")
    prem.set_defaults(func=cmd_prep_remove)
    prem.add_argument("--name", required=True)
    grp = prem.add_mutually_exclusive_group()
    grp.add_argument("--of-rest", nargs="?", const="1", default=None)
    grp.add_argument("--of-batch")
    grp.add_argument("--size", type=AMOUNT)
    prem.add_argument("--date")

    pun = command("prep-uneat")
    pun.set_defaults(func=cmd_prep_uneat)
    pun.add_argument("--name", required=True)
    grp = pun.add_mutually_exclusive_group(required=True)
    grp.add_argument("--last", action="store_true")
    grp.add_argument("--index", type=int)
    grp.add_argument("--all", action="store_true")

    par = command("prep-archive")
    par.set_defaults(func=cmd_prep_archive)
    par.add_argument("--name", required=True)

    pua = command("prep-unarchive")
    pua.set_defaults(func=cmd_prep_unarchive)
    pua.add_argument("--name")
    pua.add_argument("--id")

    pl = command("prep-list")
    pl.set_defaults(func=cmd_prep_list)
    pl.add_argument("--all", action="store_true")

    rc = command("recompute", delivers=False)
    rc.set_defaults(func=cmd_recompute)
    rc.add_argument("--from", dest="from_")

    return p


DELIVERY_FAILED = "\n[macros: delivery FAILED - relay the output above to the user yourself]\n"


def deliver_to_user(text: str) -> str | None:
    """POST the reply to the app's localhost hook, which delivers it to the user on WhatsApp and
    returns the marker to print. Returns the response body (the marker); None only if the app
    could not be reached at all - the one case the caller falls back for."""
    port = os.environ.get("PORT", "8080")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-message?source=macros",
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


def main():
    args = build_parser().parse_args()
    if not WORKSPACE.is_dir():
        die(f"no workspace at {WORKSPACE} - this is not where the user's data is")
    # Capture the command's output so it can be delivered to the user directly, while still writing
    # it to stdout so the agent sees it (for its reasoning and to detect delivery success/failure).
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            args.func(args)
    finally:
        sys.stdout.write(buffer.getvalue())
    output = buffer.getvalue()
    if output.strip() and args.delivers:
        marker = deliver_to_user(output)
        sys.stdout.write(marker if marker is not None else DELIVERY_FAILED)
    for note in NOTES:
        sys.stdout.write(f"{note}\n")


if __name__ == "__main__":
    main()
