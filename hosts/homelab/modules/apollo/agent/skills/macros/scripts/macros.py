#!/usr/bin/env python3
"""Daily nutrition tracker.

Owns all storage, arithmetic, the rolling balance ledger, and output rendering,
so none of it is ever done in-model. JSON lives under $MACROS_DIR (default
./macros, relative to the working directory) and must only ever be changed
through this script.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

MACROS_DIR = Path(os.environ.get("MACROS_DIR", "macros"))
DAYS_DIR = MACROS_DIR / "days"
GOAL_FILE = MACROS_DIR / "goal.json"
FOOD_FILE = MACROS_DIR / "food.json"
PREP_FILE = MACROS_DIR / "prep.json"


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


def find(mapping: dict, query: str):
    q = query.lower()
    for key, value in mapping.items():
        aliases = [a.lower() for a in value.get("aliases", [])]
        if q == key.lower() or q == value.get("name", "").lower() or q in aliases:
            return key, value
    return None, None


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


def refresh_ledger(date: str):
    """Sole writer of a day's cumulative + target, derived from its snapshot
    and the previous day's cumulative (reset on a phase change)."""
    path = day_path(date)
    if not path.exists():
        return
    day = load(path, {})
    prevcum = prev_cumulative(date, day["phase"])
    actual = sum(e["kcal"] for e in day["entries"])
    day["cumulative"] = prevcum + actual - day["dailyGoal"]
    day["target"] = max(day["dailyGoal"] - prevcum, floor_of(day))
    save(path, day)


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


def add_entry(date, time, item, kcal, protein, fat, carbs, note):
    ensure_day(date)
    path = day_path(date)
    day = load(path, {})
    day["entries"].append({
        "time": time, "item": item, "kcal": kcal,
        "protein": protein, "fat": fat, "carbs": carbs, "note": note or None,
    })
    save(path, day)
    refresh_ledger(date)


# --- rendering -----------------------------------------------------------

def dm(date: str) -> str:
    return f"{date[8:10]}.{date[5:7]}"


def render_day(date: str):
    path = day_path(date)
    if path.exists():
        day = load(path, {})
    elif GOAL_FILE.exists():
        # Nothing logged yet: still show the day's targets, derived from the ledger.
        g = load(GOAL_FILE, {})
        prevcum = prev_cumulative(date, g.get("phase"))
        floor = g["tdee"] - 500 if g["dailyGoal"] <= g["tdee"] else g["tdee"]
        day = {"date": date, "tdee": g["tdee"], "dailyGoal": g["dailyGoal"],
               "proteinGoal": g["proteinGoal"], "cumulative": prevcum,
               "target": max(g["dailyGoal"] - prevcum, floor),
               "weight": None, "entries": []}
    else:
        print(f"nothing logged for {date} yet - set a goal first with goal-set")
        return
    label = f"Today ({dm(date)})" if date == today() else dm(date)
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
    add_entry(date, args.time or now_time(), args.item,
              args.kcal, args.protein, args.fat, args.carbs, args.note)
    render_day(date)


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


def cmd_food_get(args):
    _, food = find(load(FOOD_FILE, {}), args.query)
    if not food:
        print(f'no saved food matches "{args.query}" - estimate it')
        return
    p = food["per100"]
    print(f"{food['name']}: per 100g {p['kcal']} kcal, {p['protein']}g P, {p['fat']}g F, "
          f"{p['carbs']}g C; default serving {food['serving']}g")


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
    key, batch = find(prep, args.name)
    if not batch:
        die(f'no prep named "{args.name}"')
    remaining = batch["remaining"]
    # --fraction is always relative to the *whole* batch; --remaining finishes it.
    if args.remaining:
        frac = remaining
    elif args.fraction is not None:
        frac = parse_fraction(args.fraction)
    else:
        die("give --fraction F (of the whole batch) or --remaining to finish it")
    if frac <= 0:
        die("fraction must be positive")
    if frac > remaining + 1e-6:
        die(f'only {round(remaining * 100)}% of "{batch["name"]}" is left '
            f"({round(batch['total']['kcal'] * remaining)} kcal); cannot eat "
            f"{round(frac * 100)}%. Use --remaining to finish it.")
    t = batch["total"]
    date = args.date or today()
    add_entry(
        date, now_time(), f"{batch['name']} ({round(frac * 100)}% of batch)",
        round(t["kcal"] * frac), r1(t["protein"] * frac), r1(t["fat"] * frac), r1(t["carbs"] * frac),
        "prep",
    )
    left = remaining - frac
    if left <= 0.0001:
        del prep[key]
    else:
        batch["remaining"] = left
        prep[key] = batch
    save(PREP_FILE, prep)
    render_day(date)


def cmd_prep_list(args):
    prep = load(PREP_FILE, {})
    if not prep:
        print("no preps saved")
        return
    for v in prep.values():
        r, t = v["remaining"], v["total"]
        print(f"- {v['name']}: {round(r * 100)}% left "
              f"({round(t['kcal'] * r)} kcal, {r1(t['protein'] * r)}g P)")


def cmd_recompute(args):
    days = sorted(p.stem for p in DAYS_DIR.glob("*.json")) if DAYS_DIR.exists() else []
    n = 0
    for d in days:
        if len(d) == 10 and (args.from_ is None or d >= args.from_):
            refresh_ledger(d)
            n += 1
    print(f"recomputed {n} day(s)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="macros.py", description="daily nutrition tracker")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("goal").set_defaults(func=cmd_goal)

    g = sub.add_parser("goal-set")
    g.set_defaults(func=cmd_goal_set)
    g.add_argument("--phase", choices=["cut", "maintenance", "bulk"])
    g.add_argument("--tdee", type=numify)
    g.add_argument("--daily-goal", type=numify)
    g.add_argument("--protein", type=numify)
    g.add_argument("--weight-goal", type=numify)

    lo = sub.add_parser("log")
    lo.set_defaults(func=cmd_log)
    lo.add_argument("--item", required=True)
    lo.add_argument("--kcal", type=numify, required=True)
    lo.add_argument("--protein", type=numify, default=0)
    lo.add_argument("--fat", type=numify, default=0)
    lo.add_argument("--carbs", type=numify, default=0)
    lo.add_argument("--note")
    lo.add_argument("--time")
    lo.add_argument("--date")

    sh = sub.add_parser("show")
    sh.set_defaults(func=cmd_show)
    sh.add_argument("--date")

    w = sub.add_parser("weight")
    w.set_defaults(func=cmd_weight)
    w.add_argument("--kg", type=numify, required=True)
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
    fa.add_argument("--kcal100", type=numify, required=True)
    fa.add_argument("--protein100", type=numify, required=True)
    fa.add_argument("--fat100", type=numify, required=True)
    fa.add_argument("--carbs100", type=numify, required=True)
    fa.add_argument("--serving", type=numify, required=True)
    fa.add_argument("--aliases")

    sub.add_parser("food-list").set_defaults(func=cmd_food_list)

    pa = sub.add_parser("prep-add")
    pa.set_defaults(func=cmd_prep_add)
    pa.add_argument("--name", required=True)
    pa.add_argument("--kcal", type=numify, required=True)
    pa.add_argument("--protein", type=numify, required=True)
    pa.add_argument("--fat", type=numify, required=True)
    pa.add_argument("--carbs", type=numify, required=True)

    pe = sub.add_parser("prep-eat")
    pe.set_defaults(func=cmd_prep_eat)
    pe.add_argument("--name", required=True)
    pe.add_argument("--fraction")
    pe.add_argument("--remaining", action="store_true")
    pe.add_argument("--date")

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
