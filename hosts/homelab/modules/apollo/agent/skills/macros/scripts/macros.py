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
import secrets
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import NamedTuple

MACROS_DIR = Path(os.environ.get("MACROS_DIR", "macros"))
DAYS_DIR = MACROS_DIR / "days"
GOAL_FILE = MACROS_DIR / "goal.json"
FOOD_FILE = MACROS_DIR / "food.json"
PREP_FILE = MACROS_DIR / "prep.json"

# Score below which difflib stops proposing a fuzzy name match (0..1).
FUZZY_CUTOFF = 0.6

# The user's day rolls over at this hour, not midnight: times before it count toward the
# previous calendar date (a 02:00 snack lands on the day before).
DAY_START_HOUR = 4


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


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


def recompute_from(date: str):
    """Re-fold the ledger for `date` and every later day in order (a change to an
    earlier day cascades forward through the rolling balance)."""
    days = sorted(p.stem for p in DAYS_DIR.glob("*.json")) if DAYS_DIR.exists() else []
    for d in days:
        if len(d) == 10 and d >= date:
            refresh_ledger(d)


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


def make_entry(time, item, kcal, protein, fat, carbs, note, *, prep_key=None, event_id=None) -> dict:
    entry = {
        "time": time, "item": item, "kcal": kcal,
        "protein": protein, "fat": fat, "carbs": carbs, "note": note or None,
    }
    if prep_key is not None:
        entry["prepKey"] = prep_key
        entry["eventId"] = event_id
    return entry


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
    day = start
    while day <= end:
        ds = day.strftime("%Y-%m-%d")
        rec = day_macros(ds)
        if rec is not None:
            if ds == today_str:
                partial = rec["macros"]
            else:
                completed.append(rec)
        day += timedelta(days=1)

    span = f"{dm(start.strftime('%Y-%m-%d'))}-{dm(end.strftime('%Y-%m-%d'))}"
    header = f"Last {label_days} day{'s' if label_days != 1 else ''} ({span})" if label_days is not None else span

    if not completed and partial is None:
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
    else:
        lines.append("No complete days logged in this range yet.")
    if partial is not None:
        lines.append(
            f"Today so far ({dm(today_str)}): {round(partial['kcal'])} kcal | "
            f"{round(partial['protein'])}g protein, {round(partial['fat'])}g fat, {round(partial['carbs'])}g carbs"
        )
    print("\n".join(lines))


def cmd_weight(args):
    date = args.date or today()
    ensure_day(date)
    day = load(day_path(date), {})
    day["weight"] = {"kg": args.kg, "at": args.at or now_time()}
    save(day_path(date), day)
    render_day(date)


def entry_locked(entry: dict) -> bool:
    """True for a day entry that projects a still-live prep consumption event: it is
    corrected through prep-uneat, not from the day. Once its batch is gone (discarded)
    the entry is plain history and freely editable again."""
    key = entry.get("prepKey")
    return bool(key) and key in load(PREP_FILE, {})


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
    for flag in ("item", "kcal", "protein", "fat", "carbs", "note"):
        value = getattr(args, flag)
        if value is not None:
            entry[flag] = value
            changed = True
    if not changed:
        die("give at least one field to change (--item/--kcal/--protein/--fat/--carbs/--note)")
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
    food = load(FOOD_FILE, {})
    key = args.name.lower()
    aliases = [a.strip().lower() for a in (args.aliases or "").split(",") if a.strip()]
    food[key] = {
        "name": args.name,
        "per100": {"kcal": args.kcal100, "protein": args.protein100, "fat": args.fat100, "carbs": args.carbs100},
        "serving": args.serving,
        "unit": args.unit or "g",
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
    unit = food.get("unit", "g")
    rate = {k: per100[k] / 100 for k in ("kcal", "protein", "fat", "carbs")}
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
    if amount <= 0:
        die("amount must be positive")
    amount = round(amount)
    kcal = round(rate["kcal"] * amount)
    protein = r1(rate["protein"] * amount)
    entry = make_entry(now_time(), f"{food['name']} ({fmt_amount(amount, unit)})",
                       kcal, protein, r1(rate["fat"] * amount), r1(rate["carbs"] * amount), None)
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
    print(f"updated food: {entry['name']}")
    print(food_line(entry))


def cmd_food_rm(args):
    food = load(FOOD_FILE, {})
    key, entry, _ = resolve(food, args.name, noun="saved food", listing="food-list", strict=True)
    del food[key]
    save(FOOD_FILE, food)
    print(f"removed food: {entry['name']}")


MACROS = ("kcal", "protein", "fat", "carbs")


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
    value = round(amount) if amount >= 10 else r1(amount)
    return f"{value}{'' if unit in TIGHT_UNITS else ' '}{unit}"


def portion_size(batch: dict, frac: float) -> str | None:
    """A fraction of the batch as a weight/volume string, or None when no size is set."""
    size = batch.get("size")
    return fmt_amount(size["amount"] * frac, size["unit"]) if size else None


def prep_line(batch: dict) -> str:
    if not batch["ingredients"]:
        return f"{batch['name']}: empty (no ingredients yet)"
    rem = prep_remaining(batch)
    size = portion_size(batch, frac_left(batch))
    size_txt = f"{size}, " if size else ""
    return (f"{batch['name']}: {round(frac_left(batch) * 100)}% left "
            f"({size_txt}{round(rem['kcal'])} kcal, {r1(rem['protein'])}g P)")


def make_event(kind: str, date: str, macros: dict, label: str) -> dict:
    """One consumption event: a portion that left the batch, eaten (logged to your day)
    or removed (unlogged). Macros are snapshotted, so past days never shift under it."""
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
                prep_key=key, event_id=event["id"]))
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


def cmd_prep_add(args):
    prep = load(PREP_FILE, {})
    key = args.name.lower()
    if key in prep:
        die(f'a prep called "{prep[key]["name"]}" already exists ({round(frac_left(prep[key]) * 100)}% left) - '
            f"add to it with prep-ingredient-add, or prep-rm first to start over.")
    size = prep_size_from_args(args)
    prep[key] = {"name": args.name, "created": today(), "size": size,
                 "ingredients": [], "consumption": []}
    save(PREP_FILE, prep)
    size_txt = f", {fmt_amount(size['amount'], size['unit'])}" if size else ""
    print(f"created prep: {args.name}{size_txt} (empty - add ingredients with prep-ingredient-add)")


def cmd_prep_size(args):
    prep = load(PREP_FILE, {})
    _, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
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


def cmd_prep_ingredient_add(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
    ingredient = {"label": args.label, "kcal": args.kcal, "protein": args.protein,
                  "fat": args.fat, "carbs": args.carbs}
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
    leads.append(f"added to {batch['name']}{mode}: {args.label} - "
                 f"{round(ingredient['kcal'])} kcal, {r1(ingredient['protein'])}g P")
    if forgotten:
        apply_delta(batch, key, ingredient, date=date, label=args.label, verb="forgotten",
                    leads=leads, log_eaten=not args.no_log_eaten)
    batch["ingredients"].append(ingredient)
    save(PREP_FILE, prep)
    leads.append(prep_line(batch))
    print("\n".join(leads))


def cmd_prep_ingredient_edit(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
    idx = pick_index(batch["ingredients"], args, "ingredient")
    ingredient = batch["ingredients"][idx]
    old = {k: ingredient[k] for k in MACROS}
    new = dict(old)
    for m in MACROS:
        value = getattr(args, m)
        if value is not None:
            new[m] = value
    label = args.label or ingredient["label"]
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    leads.append(f"updated {batch['name']} ingredient {idx + 1}: {label} - "
                 f"{round(new['kcal'])} kcal, {r1(new['protein'])}g P")
    # Correct the macro delta like a forgotten add; computed before the ingredient is
    # updated, so `total` still reflects the old values.
    apply_delta(batch, key, macro_sub(new, old), date=args.date or today(), label=label,
                verb="corrected", leads=leads, log_eaten=not args.no_log_eaten)
    ingredient.update(new)
    if args.label is not None:
        ingredient["label"] = args.label
    save(PREP_FILE, prep)
    leads.append(prep_line(batch))
    print("\n".join(leads))


def cmd_prep_ingredient_rm(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
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
    _, batch, assumed = resolve(load(PREP_FILE, {}), args.name,
                                noun="prep", listing="prep-list", strict=False)
    if assumed:
        print(f'📝 read "{args.name}" as {assumed}')
    size = batch.get("size")
    size_txt = f", {fmt_amount(size['amount'], size['unit'])}" if size else ""
    print(f"{batch['name']} ({dm(batch['created'])}){size_txt}:")
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
    key, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
    total = prep_total(batch)
    if total["kcal"] <= 0:
        die(f'"{batch["name"]}" has no ingredients yet - add some with prep-ingredient-add')
    left = frac_left(batch)
    date = args.date or today()
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    capped = False
    # --fraction/--remaining/--size are shares of the *whole* batch; --fit-*/--target-*
    # size the share for you.
    if has_target(args):
        day = compute_day(date, [])
        if day is None:
            die("no goal set - run: macros.py goal-set --tdee N --daily-goal N --protein N --phase cut")
        ideal, why, dim, requested = portion_for_target(batch["name"], total, day, args)
        frac = min(ideal, left)
        capped = ideal > left + 1e-6
    elif args.size is not None:
        if not batch.get("size"):
            die(f'"{batch["name"]}" has no size set - set one with prep-size, or use --fraction')
        frac = args.size / batch["size"]["amount"]
    elif args.remaining:
        frac = left
    elif args.fraction is not None:
        frac = parse_fraction(args.fraction)
    else:
        die("give an amount: --fraction, --remaining, --size, --fit-protein/--fit-kcal, or --target-protein/--target-kcal")
    if frac <= 0:
        die("amount must be positive")
    # An explicit over-ask is a mistake; a fit/target over-ask is capped above.
    if not has_target(args) and frac > left + 1e-6:
        die(f'only {round(left * 100)}% of "{batch["name"]}" is left '
            f"({round(total['kcal'] * left)} kcal); cannot eat "
            f"{round(frac * 100)}%. Use --remaining to finish it.")
    portion = macro_scale(total, frac)
    size_part = portion_size(batch, frac)
    item = f"{batch['name']} ({round(frac * 100)}% of batch{f', {size_part}' if size_part else ''})"
    entry = make_entry(now_time(), item, round(portion["kcal"]), r1(portion["protein"]),
                       r1(portion["fat"]), r1(portion["carbs"]), "prep")
    if has_target(args):
        size_hint = f" (~{size_part})" if size_part else ""
        leads.append(f"🍽️ {batch['name']}: {round(frac * 100)}% of batch{size_hint} {why} - "
                     f"{round(portion['kcal'])} kcal, {r1(portion['protein'])}g P")
        if capped:
            short = requested - portion[dim]
            short_txt = f"{round(short)}g P" if dim == "protein" else f"{round(short)} kcal"
            leads.append(f"⚠️ only {round(left * 100)}% of the batch is left - "
                         f"capped to that, {short_txt} short of the target.")

    def commit():
        event = make_event("eaten", date, portion, f"{round(frac * 100)}% of batch")
        append_entry(date, make_entry(now_time(), item, round(portion["kcal"]), r1(portion["protein"]),
                                      r1(portion["fat"]), r1(portion["carbs"]), "prep",
                                      prep_key=key, event_id=event["id"]))
        batch["consumption"].append(event)
        prep[key] = batch
        save(PREP_FILE, prep)

    emit(date, entry, dry_run=args.dry_run, lead="\n".join(leads) or None, commit=commit)


def cmd_prep_remove(args):
    prep = load(PREP_FILE, {})
    key, batch, assumed = resolve(prep, args.name, noun="prep", listing="prep-list", strict=False)
    total = prep_total(batch)
    if total["kcal"] <= 0:
        die(f'"{batch["name"]}" has no ingredients yet')
    left = frac_left(batch)
    if args.size is not None:
        if not batch.get("size"):
            die(f'"{batch["name"]}" has no size set - set one with prep-size, or use --fraction')
        frac = args.size / batch["size"]["amount"]
    elif args.remaining:
        frac = left
    elif args.fraction is not None:
        frac = parse_fraction(args.fraction)
    else:
        die("give an amount: --fraction, --remaining, or --size")
    if frac <= 0:
        die("amount must be positive")
    if frac > left + 1e-6:
        die(f'only {round(left * 100)}% of "{batch["name"]}" is left; cannot remove {round(frac * 100)}%. '
            f"Use --remaining to clear the rest.")
    portion = macro_scale(total, frac)
    batch["consumption"].append(make_event("removed", args.date or today(), portion, "unlogged"))
    prep[key] = batch
    save(PREP_FILE, prep)
    leads = [f'📝 read "{args.name}" as {assumed}'] if assumed else []
    leads.append(f"removed {round(frac * 100)}% of {batch['name']} (unlogged - not your intake)")
    leads.append(prep_line(batch))
    print("\n".join(leads))


def remove_linked_entry(event: dict, dates: set):
    """Drop the day entry that projects `event`, noting its date for a ledger refresh."""
    path = day_path(event["date"])
    if not path.exists():
        return
    day = load(path, {})
    kept = [e for e in day["entries"] if e.get("eventId") != event["id"]]
    if len(kept) != len(day["entries"]):
        day["entries"] = kept
        save(path, day)
        dates.add(event["date"])


def cmd_prep_uneat(args):
    prep = load(PREP_FILE, {})
    key, batch, _ = resolve(prep, args.name, noun="prep", listing="prep-list", strict=True)
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
    shown = [b for b in prep.values() if args.all or not b["ingredients"] or frac_left(b) > 0.0001]
    if not shown:
        print("no active preps" if prep else "no preps saved")
        return
    for b in shown:
        print(f"- {prep_line(b)}")


def cmd_prep_rm(args):
    prep = load(PREP_FILE, {})
    key, batch, _ = resolve(prep, args.name, noun="prep", listing="prep-list", strict=True)
    del prep[key]
    save(PREP_FILE, prep)
    print(f"removed prep: {batch['name']} (was {round(frac_left(batch) * 100)}% left)")


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

    sm = sub.add_parser("summary")
    sm.set_defaults(func=cmd_summary)
    grp = sm.add_mutually_exclusive_group()
    grp.add_argument("--days", type=int)
    grp.add_argument("--from", dest="from_")
    sm.add_argument("--to")

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

    ed = sub.add_parser("edit")
    ed.set_defaults(func=cmd_edit)
    ed.add_argument("--last", action="store_true")
    ed.add_argument("--index", type=int)
    ed.add_argument("--item")
    ed.add_argument("--kcal", type=nonneg)
    ed.add_argument("--protein", type=nonneg)
    ed.add_argument("--fat", type=nonneg)
    ed.add_argument("--carbs", type=nonneg)
    ed.add_argument("--note")
    ed.add_argument("--date")

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
    fa.add_argument("--unit")
    fa.add_argument("--aliases")

    sub.add_parser("food-list").set_defaults(func=cmd_food_list)

    fe = sub.add_parser("food-eat")
    fe.set_defaults(func=cmd_food_eat)
    fe.add_argument("--name", required=True)
    add_amount_flags(fe, ("--amount", {"type": positive}), ("--servings", {"type": positive}))

    fed = sub.add_parser("food-edit")
    fed.set_defaults(func=cmd_food_edit)
    fed.add_argument("--name", required=True)
    fed.add_argument("--kcal100", type=nonneg)
    fed.add_argument("--protein100", type=nonneg)
    fed.add_argument("--fat100", type=nonneg)
    fed.add_argument("--carbs100", type=nonneg)
    fed.add_argument("--serving", type=positive)
    fed.add_argument("--unit")
    fed.add_argument("--rename")
    fed.add_argument("--aliases")

    frm = sub.add_parser("food-rm")
    frm.set_defaults(func=cmd_food_rm)
    frm.add_argument("--name", required=True)

    pa = sub.add_parser("prep-add")
    pa.set_defaults(func=cmd_prep_add)
    pa.add_argument("--name", required=True)
    pa.add_argument("--size", type=positive)
    pa.add_argument("--unit")

    psz = sub.add_parser("prep-size")
    psz.set_defaults(func=cmd_prep_size)
    psz.add_argument("--name", required=True)
    grp = psz.add_mutually_exclusive_group(required=True)
    grp.add_argument("--size", type=positive)
    grp.add_argument("--clear", action="store_true")
    psz.add_argument("--unit")

    ping = sub.add_parser("prep-ingredient-add")
    ping.set_defaults(func=cmd_prep_ingredient_add)
    ping.add_argument("--name", required=True)
    ping.add_argument("--label", required=True)
    ping.add_argument("--kcal", type=nonneg, required=True)
    ping.add_argument("--protein", type=nonneg, default=0)
    ping.add_argument("--fat", type=nonneg, default=0)
    ping.add_argument("--carbs", type=nonneg, default=0)
    ping.add_argument("--later", action="store_true")
    ping.add_argument("--no-log-eaten", action="store_true")
    ping.add_argument("--date")

    pied = sub.add_parser("prep-ingredient-edit")
    pied.set_defaults(func=cmd_prep_ingredient_edit)
    pied.add_argument("--name", required=True)
    pied.add_argument("--last", action="store_true")
    pied.add_argument("--index", type=int)
    pied.add_argument("--label")
    pied.add_argument("--kcal", type=nonneg)
    pied.add_argument("--protein", type=nonneg)
    pied.add_argument("--fat", type=nonneg)
    pied.add_argument("--carbs", type=nonneg)
    pied.add_argument("--no-log-eaten", action="store_true")
    pied.add_argument("--date")

    pirm = sub.add_parser("prep-ingredient-rm")
    pirm.set_defaults(func=cmd_prep_ingredient_rm)
    pirm.add_argument("--name", required=True)
    pirm.add_argument("--last", action="store_true")
    pirm.add_argument("--index", type=int)
    pirm.add_argument("--no-log-eaten", action="store_true")
    pirm.add_argument("--date")

    pget = sub.add_parser("prep-get")
    pget.set_defaults(func=cmd_prep_get)
    pget.add_argument("--name", required=True)

    pe = sub.add_parser("prep-eat")
    pe.set_defaults(func=cmd_prep_eat)
    pe.add_argument("--name", required=True)
    add_amount_flags(pe, ("--fraction", {}), ("--remaining", {"action": "store_true"}),
                     ("--size", {"type": positive}))

    prem = sub.add_parser("prep-remove")
    prem.set_defaults(func=cmd_prep_remove)
    prem.add_argument("--name", required=True)
    grp = prem.add_mutually_exclusive_group()
    grp.add_argument("--fraction")
    grp.add_argument("--remaining", action="store_true")
    grp.add_argument("--size", type=positive)
    prem.add_argument("--date")

    pun = sub.add_parser("prep-uneat")
    pun.set_defaults(func=cmd_prep_uneat)
    pun.add_argument("--name", required=True)
    grp = pun.add_mutually_exclusive_group(required=True)
    grp.add_argument("--last", action="store_true")
    grp.add_argument("--index", type=int)
    grp.add_argument("--all", action="store_true")

    prm = sub.add_parser("prep-rm")
    prm.set_defaults(func=cmd_prep_rm)
    prm.add_argument("--name", required=True)

    pl = sub.add_parser("prep-list")
    pl.set_defaults(func=cmd_prep_list)
    pl.add_argument("--all", action="store_true")

    rc = sub.add_parser("recompute")
    rc.set_defaults(func=cmd_recompute)
    rc.add_argument("--from", dest="from_")

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
