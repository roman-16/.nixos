---
name: macros
description: Track daily nutrition - calories and macros (protein, fat, carbs). Use whenever the user mentions food, a meal, eating something, a food photo, calories, protein, macros, their weight, or nutrition goals.
---

# Macros

Tracks daily nutrition as JSON under `macros/` in the working directory. Every read and write goes through the CLI; never edit the JSON by hand and never do the arithmetic yourself - the script owns all totals and the rolling balance.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/macros.py <command> [flags]
```

## Your job vs the script's job

- **You:** read the message, identify the food and amount, and get its macros - look it up with `food-get` first, otherwise estimate from knowledge or a photo and pass `--note estimated`. Then call `log`.
- **The script:** stores entries, computes every total and the balance ledger, and prints the reply to send. It owns all numbers.

## Setup (once, or when targets change)

```bash
{baseDir}/scripts/macros.py goal-set --phase cut --tdee 2400 --daily-goal 2100 --protein 150 --weight-goal 66
{baseDir}/scripts/macros.py goal
```

`daily-goal` is the kcal anchor the ledger steers the multi-day average toward; `tdee` is maintenance and sets the floor. Phase is `cut`, `maintenance`, or `bulk`.

## Logging food

`--kcal` is required; `--protein/--fat/--carbs` default to 0; time and date default to now.

```bash
{baseDir}/scripts/macros.py log --item "Chicken breast (250g)" --kcal 413 --protein 77.5 --fat 9 --carbs 0
{baseDir}/scripts/macros.py log --item "Burger and fries" --kcal 900 --protein 40 --fat 45 --carbs 80 --note estimated
```

`log` prints the day summary - relay that as the reply.

## Viewing a day

```bash
{baseDir}/scripts/macros.py show                     # today
{baseDir}/scripts/macros.py show --date 2026-07-12
```

## Saved foods (per 100g + default serving)

Look up before estimating; use the default serving when no amount is given. Only add a food when the user explicitly asks to save one.

```bash
{baseDir}/scripts/macros.py food-get skyr
{baseDir}/scripts/macros.py food-add --name "Skyr, plain" --kcal100 64 --protein100 11 --fat100 0.1 --carbs100 4 --serving 500 --aliases "skyr,my skyr"
```

## Weight

```bash
{baseDir}/scripts/macros.py weight --kg 66.4
```

## Fixing mistakes

```bash
{baseDir}/scripts/macros.py rm --last
{baseDir}/scripts/macros.py rm --index 2      # remove the 2nd entry of the day
```

## Meal prep (batch cooking)

Cooking changes weight, so a batch is tracked by its whole-batch macros and the fraction left, not per 100g.

```bash
{baseDir}/scripts/macros.py prep-add --name "Bolognese" --kcal 1800 --protein 120 --fat 90 --carbs 110
{baseDir}/scripts/macros.py prep-eat --name bolognese --fraction 1/5    # also accepts 20% or 0.2
{baseDir}/scripts/macros.py prep-list
```

## Repairing the ledger

After a manual JSON edit or a phase change, re-fold the balance forward:

```bash
{baseDir}/scripts/macros.py recompute
```

## Notes

- Dates and times come from the system clock; only pass `--date`/`--time` to correct a past entry.
- Estimate freely for vague inputs or photos and pass `--note estimated` - the totals stay exact regardless.
- Keep chat replies short: relay the script's summary as-is.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
