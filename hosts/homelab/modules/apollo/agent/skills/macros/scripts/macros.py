#!/usr/bin/env python3
"""Daily nutrition tracker.

Owns all storage, arithmetic, the rolling balance ledger, and output rendering,
so none of it is ever done in-model. JSON lives under $MACROS_DIR (default
./macros, relative to the working directory) and must only ever be changed
through this script.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

MACROS_DIR = Path(os.environ.get("MACROS_DIR", "macros"))
DAYS_DIR = MACROS_DIR / "days"
GOAL_FILE = MACROS_DIR / "goal.json"
FOOD_FILE = MACROS_DIR / "food.json"
PREP_FILE = MACROS_DIR / "prep.json"

# Score below which difflib stops proposing a fuzzy name match (0..1).
FUZZY_CUTOFF = 0.6


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def now_time() -> str:
    return datetime.now().strftime("%H:%M")


def numify(value) -> float | int:
    """Parse a number, tolerating thousands separators; int when whole."""
    x = float(str(value).replace(",", ""))
    return int(x) if x == int(x) else x


def nonneg(value) -> float | int:
    """argparse type: a number that must be >= 0 (0 is allowed, e.g. black coffee)."""
    x = numify(value)
    if x < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return x


def positive(value) -> float | int:
    """argparse type: a number that must be > 0."""
    x = numify(value)
    if x <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return x


def r1(x) -> float | int:
    x = round(float(x), 1)
    return int(x) if x == int(x) else x


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


def compute_day(date: str, extra_entries=()) -> dict | None:
    """A day's in-memory snapshot with the ledger applied and `extra_entries`
    appended, persisting nothing. Uses the stored day, or synthesizes one from
    the goal when nothing is logged yet; returns None when there is neither a
    day nor a goal (so callers can prompt for goal-set)."""
    path = day_path(date)
    if path.exists():
        day = load(path, {})
    elif GOAL_FILE.exists():
        g = load(GOAL_FILE, {})
        day = {
            "date": date, "phase": g.get("phase"), "tdee": g.get("tdee"),
            "dailyGoal": g.get("dailyGoal"), "proteinGoal": g.get("proteinGoal"),
            "target": g.get("dailyGoal"), "cumulative": 0, "weight": None, "entries": [],
        }
    else:
        return None
    if extra_entries:
        day = {**day, "entries": [*day["entries"], *extra_entries]}
    return _apply_ledger(day)


def ensure_day(date: str):
    if day_path(date).exists():
        return
    if not GOAL_FILE.exists():
        die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
    g = load(GOAL_FILE, {})
    save(day_path(date), {
        "date": date,
        "phase": g.get("phase"),
        "tdee": g.get("tdee"),
        "dailyGoal": g.get("dailyGoal"),
        "proteinGoal": g.get("proteinGoal"),
        "target": g.get("dailyGoal"),
        "cumulative": 0,
        "weight": None,
        "entries": [],
    })
    refresh_ledger(date)


def make_entry(time, item, kcal, protein, fat, carbs, note) -> dict:
    return {
        "time": time, "item": item, "kcal": kcal,
        "protein": protein, "fat": fat, "carbs": carbs, "note": note or None,
    }


def append_entry(date: str, entry: dict):
    ensure_day(date)
    path = day_path(date)
    day = load(path, {})
    day["entries"].append(entry)
    save(path, day)
    refresh_ledger(date)


# --- portions (target/fit sizing + preview) ------------------------------

def has_target(args) -> bool:
    """Whether a --fit-*/--target-* amount source was requested."""
    return bool(
        args.fit_protein or args.fit_kcal
        or args.target_protein is not None or args.target_kcal is not None
    )


def portion_for_target(name: str, rate: dict, day: dict, args):
    """Amount of a scalable food/batch that meets a --fit-*/--target-* request.
    `rate` is the per-unit macro map (per gram for a food, per whole batch for a
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
        render_day(date)


# --- rendering -----------------------------------------------------------

def dm(date: str) -> str:
    return f"{date[8:10]}.{date[5:7]}"


def render_day_dict(day: dict, *, preview: bool = False):
    date = day["date"]
    base = f"Today ({dm(date)})" if date == today() else dm(date)
    label = f"{base} - preview, not logged" if preview else base
    entries = day["entries"]
    protein_goal = day["proteinGoal"]
    if not entries:
        print(f"{label}: nothing logged yet.")
        print(f"Target: {day['target']} kcal, {protein_goal}g+ protein")
        return
    tk = sum(e["kcal"] for e in entries)
    tp = sum(e["protein"] for e in entries)
    tf = sum(e["fat"] for e in entries)
    tc = sum(e["carbs"] for e in entries)
    weight_goal = load(GOAL_FILE, {}).get("weightGoal", "?")
    tomorrow = max(day["dailyGoal"] - day["cumulative"], floor_of(day))
    left = day["target"] - tk

    lines = [f"{label}:", ""]
    for e in entries:
        note = f" [{e['note']}]" if e.get("note") else ""
        lines.append(f"- {e['item']} - {e['kcal']} kcal, {round(e['protein'])}g P{note}")
    kcal_part = f"{round(left)} kcal left" if left >= 0 else f"{round(-left)} kcal over"
    protein_part = "protein hit ✅" if tp >= protein_goal else f"{round(protein_goal - tp)}g protein to go"
    weight = f"Weight {day['weight']['kg']} kg (goal {weight_goal}). " if day.get("weight") else ""
    lines += [
        "",
        f"Total: {round(tk)} kcal | {round(tp)}g protein, {round(tf)}g fat, {round(tc)}g carbs",
        f"Target: {day['target']} kcal, {protein_goal}g+ protein",
        f"Left: {kcal_part}, {protein_part}",
        f"{weight}Tomorrow's target: {tomorrow} kcal.",
    ]
    print("\n".join(lines))


def render_day(date: str):
    day = compute_day(date)
    if day is None:
        print(f"nothing logged for {date} yet - set a goal first with goal-set")
        return
    render_day_dict(day)


# --- commands ------------------------------------------------------------

def cmd_goal(args):
    if not GOAL_FILE.exists():
        die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
    g = load(GOAL_FILE, {})
    print(f"Phase: {g.get('phase')}")
    print(f"TDEE: {g.get('tdee')} kcal")
    print(f"Daily goal: {g.get('dailyGoal')} kcal")
    print(f"Protein: {g.get('proteinGoal')} g")
    print(f"Weight goal: {g.get('weightGoal')} kg")


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
    entry = make_entry(args.time or now_time(), args.item,
                       args.kcal, args.protein, args.fat, args.carbs, args.note)
    emit(date, entry, dry_run=args.dry_run, commit=lambda: append_entry(date, entry))


def cmd_show(args):
    render_day(args.date or today())


def cmd_weight(args):
    date = args.date or today()
    ensure_day(date)
    day = load(day_path(date), {})
    day["weight"] = {"kg": args.kg, "at": args.at or now_time()}
    save(day_path(date), day)
    render_day(date)


def cmd_rm(args):
    date = args.date or today()
    path = day_path(date)
    if not path.exists():
        die(f"nothing logged for {date}")
    day = load(path, {})
    if args.last:
        if day["entries"]:
            day["entries"].pop()
    elif args.index is not None:
        i = args.index - 1
        if not 0 <= i < len(day["entries"]):
            die(f"no entry #{args.index}")
        day["entries"].pop(i)
    else:
        die("usage: rm --last | --index N")
    save(path, day)
    refresh_ledger(date)
    render_day(date)


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


def food_line(food: dict) -> str:
    p = food["per100"]
    return (f"{food['name']}: per 100g {p['kcal']} kcal, {p['protein']}g P, {p['fat']}g F, "
            f"{p['carbs']}g C; default serving {food['serving']}g")


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
    food = load(FOOD_FILE, {})
    key = args.name.lower()
    aliases = [a.strip().lower() for a in (args.aliases or "").split(",") if a.strip()]
    food[key] = {
        "name": args.name,
        "per100": {"kcal": args.kcal100, "protein": args.protein100, "fat": args.fat100, "carbs": args.carbs100},
        "serving": args.serving,
        "aliases": sorted(set(aliases) | {key}),
    }
    save(FOOD_FILE, food)
    print(f"saved food: {args.name}")


def cmd_food_list(args):
    food = load(FOOD_FILE, {})
    if not food:
        print("no foods saved")
        return
    for v in food.values():
        print(f"- {v['name']}  (aliases: {', '.join(v.get('aliases', []))})")


def cmd_food_eat(args):
    _, food, assumed = resolve(load(FOOD_FILE, {}), args.name,
                               noun="saved food", listing="food-list", strict=False)
    per100 = food["per100"]
    rate = {k: per100[k] / 100 for k in ("kcal", "protein", "fat", "carbs")}
    date = args.date or today()
    why = None
    if has_target(args):
        day = compute_day(date, [])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        grams, why, _, _ = portion_for_target(food["name"], rate, day, args)
    elif args.grams is not None:
        grams = args.grams
    elif args.servings is not None:
        grams = args.servings * food["serving"]
    else:
        grams = food["serving"]
    if grams <= 0:
        die("amount must be positive")
    grams = round(grams)
    kcal = round(rate["kcal"] * grams)
    protein = r1(rate["protein"] * grams)
    entry = make_entry(now_time(), f"{food['name']} ({grams}g)",
                       kcal, protein, r1(rate["fat"] * grams), r1(rate["carbs"] * grams), None)
    leads = []
    if assumed:
        leads.append(f'📝 read "{args.name}" as {assumed}')
    if why:
        leads.append(f"🍽️ {food['name']}: {grams}g {why} - {kcal} kcal, {protein}g P")
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
    print(f"updated food: {entry['name']}")
    print(food_line(entry))


def cmd_food_rm(args):
    food = load(FOOD_FILE, {})
    key, entry, _ = resolve(food, args.name, noun="saved food", listing="food-list", strict=True)
    del food[key]
    save(FOOD_FILE, food)
    print(f"removed food: {entry['name']}")


def cmd_prep_add(args):
    prep = load(PREP_FILE, {})
    prep[args.name.lower()] = {
        "name": args.name,
        "created": today(),
        "total": {"kcal": args.kcal, "protein": args.protein, "fat": args.fat, "carbs": args.carbs},
        "remaining": 1,
    }
    save(PREP_FILE, prep)
    print(f"saved prep: {args.name} (100% remaining)")


def cmd_prep_eat(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
    remaining = batch["remaining"]
    total = batch["total"]
    date = args.date or today()
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    capped = False
    # --fraction/--remaining are shares of the *whole* batch; --fit-*/--target-*
    # size the share for you.
    if has_target(args):
        day = compute_day(date, [])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        ideal, why, dim, requested = portion_for_target(batch["name"], total, day, args)
        frac = min(ideal, remaining)
        capped = ideal > remaining + 1e-6
    elif args.remaining:
        frac = remaining
    elif args.fraction is not None:
        frac = parse_fraction(args.fraction)
    else:
        die("give an amount: --fraction, --remaining, --fit-protein/--fit-kcal, or --target-protein/--target-kcal")
    if frac <= 0:
        die("fraction must be positive")
    # An explicit --fraction over-ask is a mistake; a fit/target over-ask is capped above.
    if not has_target(args) and frac > remaining + 1e-6:
        die(f'only {round(remaining * 100)}% of "{batch["name"]}" is left '
            f"({round(total['kcal'] * remaining)} kcal); cannot eat "
            f"{round(frac * 100)}%. Use --remaining to finish it.")
    kcal = round(total["kcal"] * frac)
    protein = r1(total["protein"] * frac)
    entry = make_entry(now_time(), f"{batch['name']} ({round(frac * 100)}% of batch)",
                       kcal, protein, r1(total["fat"] * frac), r1(total["carbs"] * frac), "prep")
    if has_target(args):
        leads.append(f"🍽️ {batch['name']}: {round(frac * 100)}% of batch {why} - {kcal} kcal, {protein}g P")
        if capped:
            short = requested - frac * total[dim]
            short_txt = f"{round(short)}g P" if dim == "protein" else f"{round(short)} kcal"
            leads.append(f"⚠️ only {round(remaining * 100)}% of the batch is left - "
                         f"capped to that, {short_txt} short of the target.")

    def commit():
        append_entry(date, entry)
        left = remaining - frac
        if left <= 0.0001:
            del prep[key]
        else:
            batch["remaining"] = left
            prep[key] = batch
        save(PREP_FILE, prep)

    emit(date, entry, dry_run=args.dry_run, lead="\n".join(leads) or None, commit=commit)


def cmd_prep_list(args):
    prep = load(PREP_FILE, {})
    if not prep:
        print("no preps saved")
        return
    for v in prep.values():
        r, t = v["remaining"], v["total"]
        print(f"- {v['name']}: {round(r * 100)}% left "
              f"({round(t['kcal'] * r)} kcal, {r1(t['protein'] * r)}g P)")


def cmd_prep_rm(args):
    prep = load(PREP_FILE, {})
    key, batch, _ = resolve(prep, args.name, noun="prep", listing="prep-list", strict=True)
    del prep[key]
    save(PREP_FILE, prep)
    print(f"removed prep: {batch['name']} (was {round(batch['remaining'] * 100)}% left)")


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
    group.add_argument("--target-protein", type=positive)
    group.add_argument("--target-kcal", type=positive)
    sp.add_argument("--dry-run", action="store_true")
    sp.add_argument("--date")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="macros.py", description="daily nutrition tracker")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("goal").set_defaults(func=cmd_goal)

    g = sub.add_parser("goal-set")
    g.set_defaults(func=cmd_goal_set)
    g.add_argument("--phase", choices=["cut", "maintenance", "bulk"])
    g.add_argument("--tdee", type=positive)
    g.add_argument("--daily-goal", type=positive)
    g.add_argument("--protein", type=positive)
    g.add_argument("--weight-goal", type=positive)

    lo = sub.add_parser("log")
    lo.set_defaults(func=cmd_log)
    lo.add_argument("--item", required=True)
    lo.add_argument("--kcal", type=nonneg, required=True)
    lo.add_argument("--protein", type=nonneg, default=0)
    lo.add_argument("--fat", type=nonneg, default=0)
    lo.add_argument("--carbs", type=nonneg, default=0)
    lo.add_argument("--note")
    lo.add_argument("--time")
    lo.add_argument("--date")
    lo.add_argument("--dry-run", action="store_true")

    sh = sub.add_parser("show")
    sh.set_defaults(func=cmd_show)
    sh.add_argument("--date")

    w = sub.add_parser("weight")
    w.set_defaults(func=cmd_weight)
    w.add_argument("--kg", type=positive, required=True)
    w.add_argument("--at")
    w.add_argument("--date")

    rm = sub.add_parser("rm")
    rm.set_defaults(func=cmd_rm)
    rm.add_argument("--last", action="store_true")
    rm.add_argument("--index", type=int)
    rm.add_argument("--date")

    en = sub.add_parser("entries")
    en.set_defaults(func=cmd_entries)
    en.add_argument("--date")

    fg = sub.add_parser("food-get")
    fg.set_defaults(func=cmd_food_get)
    fg.add_argument("query")

    fa = sub.add_parser("food-add")
    fa.set_defaults(func=cmd_food_add)
    fa.add_argument("--name", required=True)
    fa.add_argument("--kcal100", type=nonneg, required=True)
    fa.add_argument("--protein100", type=nonneg, required=True)
    fa.add_argument("--fat100", type=nonneg, required=True)
    fa.add_argument("--carbs100", type=nonneg, required=True)
    fa.add_argument("--serving", type=positive, required=True)
    fa.add_argument("--aliases")

    sub.add_parser("food-list").set_defaults(func=cmd_food_list)

    fe = sub.add_parser("food-eat")
    fe.set_defaults(func=cmd_food_eat)
    fe.add_argument("--name", required=True)
    add_amount_flags(fe, ("--grams", {"type": positive}), ("--servings", {"type": positive}))

    fed = sub.add_parser("food-edit")
    fed.set_defaults(func=cmd_food_edit)
    fed.add_argument("--name", required=True)
    fed.add_argument("--kcal100", type=nonneg)
    fed.add_argument("--protein100", type=nonneg)
    fed.add_argument("--fat100", type=nonneg)
    fed.add_argument("--carbs100", type=nonneg)
    fed.add_argument("--serving", type=positive)
    fed.add_argument("--rename")
    fed.add_argument("--aliases")

    frm = sub.add_parser("food-rm")
    frm.set_defaults(func=cmd_food_rm)
    frm.add_argument("--name", required=True)

    pa = sub.add_parser("prep-add")
    pa.set_defaults(func=cmd_prep_add)
    pa.add_argument("--name", required=True)
    pa.add_argument("--kcal", type=nonneg, required=True)
    pa.add_argument("--protein", type=nonneg, required=True)
    pa.add_argument("--fat", type=nonneg, required=True)
    pa.add_argument("--carbs", type=nonneg, required=True)

    pe = sub.add_parser("prep-eat")
    pe.set_defaults(func=cmd_prep_eat)
    pe.add_argument("--name", required=True)
    add_amount_flags(pe, ("--fraction", {}), ("--remaining", {"action": "store_true"}))

    prm = sub.add_parser("prep-rm")
    prm.set_defaults(func=cmd_prep_rm)
    prm.add_argument("--name", required=True)

    sub.add_parser("prep-list").set_defaults(func=cmd_prep_list)

    rc = sub.add_parser("recompute")
    rc.set_defaults(func=cmd_recompute)
    rc.add_argument("--from", dest="from_")

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
