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

- **You:** read the message and identify the food and the amount. For a saved food, log it with `food-eat` (the script scales per-100g - never multiply yourself); for a batch, use `prep-eat`; for anything not saved, estimate the macros from knowledge or a photo and `log` them with `--note estimated`.
- **The script:** does all scaling and portioning, stores entries, computes every total and the balance ledger, and prints the reply to send. It owns every number.

## Replying

Whenever a command prints a day summary or list (`log`, `food-eat`, `show`, `entries`, `prep-eat`, `prep-list`, `food-list`, `goal`), your reply **is** that output, sent back verbatim: the exact lines the script printed, in full and unchanged. Do not summarize it, rephrase it, reformat it, turn it into prose, trim it, or wrap it in your own commentary - the user wants to read the list itself.

A `--dry-run` preview (see [Previewing](#previewing)) is relayed the same way, verbatim - but because it answers a "what if", you may add one short line after it, e.g. "Want me to log it?".

## Setup (once, or when targets change)

```bash
{baseDir}/scripts/macros.py goal-set --phase cut --tdee 2400 --daily-goal 2100 --protein 150 --weight-goal 66
{baseDir}/scripts/macros.py goal
```

`daily-goal` is the kcal anchor the ledger steers the multi-day average toward; `tdee` is maintenance and sets the floor. Phase is `cut`, `maintenance`, or `bulk`.

## Logging food (one-off / estimated)

`log` is for entries where you supply the macros yourself - a one-off, or something not saved. Saved foods go through `food-eat` and batches through `prep-eat` (both below); reach for `log` only when neither fits. `--kcal` is required; `--protein/--fat/--carbs` default to 0; time and date default to now.

```bash
{baseDir}/scripts/macros.py log --item "Chicken breast (250g)" --kcal 413 --protein 77.5 --fat 9 --carbs 0
{baseDir}/scripts/macros.py log --item "Burger and fries" --kcal 900 --protein 40 --fat 45 --carbs 80 --note estimated
```

`log` prints the day summary - send that exact output back as your reply, verbatim (see [Replying](#replying)).

## Viewing a day

```bash
{baseDir}/scripts/macros.py show                     # today
{baseDir}/scripts/macros.py show --date 2026-07-12
```

## Saved foods (per 100g + default serving)

`food-eat` logs a saved food and does the scaling for you - never multiply per-100g by hand. Give an amount, or omit it for the default serving:

```bash
{baseDir}/scripts/macros.py food-eat --name skyr                      # one default serving
{baseDir}/scripts/macros.py food-eat --name skyr --grams 400
{baseDir}/scripts/macros.py food-eat --name skyr --servings 2
{baseDir}/scripts/macros.py food-eat --name skyr --fit-protein        # enough to reach today's protein goal
{baseDir}/scripts/macros.py food-eat --name skyr --target-protein 40  # enough to supply 40g protein
```

`--fit-kcal` and `--target-kcal` size by calories the same way. `food-eat` prints the day summary - relay it verbatim.

`food-get` looks a food up; `food-add` saves one (only when the user explicitly asks); `food-edit` corrects a saved food's numbers or name; `food-rm` deletes one. Look one up before estimating.

```bash
{baseDir}/scripts/macros.py food-get skyr
{baseDir}/scripts/macros.py food-add --name "Skyr, plain" --kcal100 64 --protein100 11 --fat100 0.1 --carbs100 4 --serving 500 --aliases "skyr,my skyr"
{baseDir}/scripts/macros.py food-edit --name skyr --kcal100 63 --serving 450   # only what you pass changes; also --rename, --aliases
{baseDir}/scripts/macros.py food-rm --name skyr
```

Name matching is forgiving: an exact alias wins, else a unique substring, else the closest spelling. On the logging path a lone close match is logged and announced (`read "skyer" as Skyr, plain`); when several foods match it asks you to pick, and `food-edit`/`food-rm` never act on a guess (re-run with the exact name). On a miss, check `food-list`.

## Weight

```bash
{baseDir}/scripts/macros.py weight --kg 66.4
```

## Fixing mistakes

```bash
{baseDir}/scripts/macros.py entries        # the day's entries with their index numbers
{baseDir}/scripts/macros.py rm --last
{baseDir}/scripts/macros.py rm --index 2   # remove the 2nd entry (use `entries` to find the number)
```

## Meal prep (batch cooking)

Cooking changes weight, so a batch is tracked by its whole-batch macros and the fraction left, not per 100g.

```bash
{baseDir}/scripts/macros.py prep-add --name "Bolognese" --kcal 1800 --protein 120 --fat 90 --carbs 110
{baseDir}/scripts/macros.py prep-eat --name bolognese --fraction 1/5    # 1/5 of the WHOLE batch (also 20% or 0.2)
{baseDir}/scripts/macros.py prep-eat --name bolognese --remaining       # finish whatever is left
{baseDir}/scripts/macros.py prep-eat --name bolognese --fit-protein     # enough to reach today's protein goal
{baseDir}/scripts/macros.py prep-eat --name bolognese --target-kcal 500 # a portion worth 500 kcal
{baseDir}/scripts/macros.py prep-list                                   # each batch with its remaining kcal/protein
{baseDir}/scripts/macros.py prep-rm --name bolognese                     # discard a batch WITHOUT logging it (spoiled/scrapped)
```

`--fraction` is a share of the original batch (not of what remains) and errors if it exceeds what is left; use `--remaining` to eat the rest. `--fit-*`/`--target-*` size the portion for you, and if the goal needs more than is left they cap to what remains and say how far short it lands.

## Previewing

`log`, `food-eat`, and `prep-eat` all take `--dry-run`: it prints the day exactly as it would look with the entry added, but saves nothing - no entry stored, no batch consumed. Use it for "how would my day look" and "how much of X can I eat"; pair it with `--fit-protein` to answer "how much do I need to hit my protein" in a single call.

```bash
{baseDir}/scripts/macros.py prep-eat --name "ice cream" --fit-protein --dry-run
{baseDir}/scripts/macros.py log --item "second helping" --kcal 600 --protein 35 --dry-run
```

## Repairing the ledger

After a manual JSON edit or a phase change, re-fold the balance forward:

```bash
{baseDir}/scripts/macros.py recompute
```

## Notes

- Dates and times come from the system clock; only pass `--date`/`--time` to correct a past entry.
- Estimate freely for vague inputs or photos and pass `--note estimated` - the totals stay exact regardless.
- Every macro must be non-negative and every amount positive; the script rejects impossible values, so a slip like `--kcal -5` errors out instead of silently corrupting a total.
- For "how much to hit X" or "how would my day look", use `--fit-*`/`--target-*` and `--dry-run` - never work out the amount or the projected totals yourself.
- Relay the script's output verbatim (see [Replying](#replying)) - never paraphrase its numbers, shorten its summary, or reformat the list.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
