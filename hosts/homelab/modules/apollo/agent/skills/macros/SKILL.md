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

Whenever a command prints a day summary or list (`log`, `food-eat`, `show`, `entries`, `edit`, `prep-eat`, `prep-list`, `prep-get`, `food-list`, `goal`), your reply **is** that output, sent back verbatim: the exact lines the script printed, in full and unchanged. Do not summarize it, rephrase it, reformat it, turn it into prose, trim it, or wrap it in your own commentary - the user wants to read the list itself.

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
{baseDir}/scripts/macros.py edit --last --kcal 538 --item "Ice cream (215g)"   # fix values in place; only what you pass changes
{baseDir}/scripts/macros.py edit --index 2 --protein 30                        # correct the 2nd entry
{baseDir}/scripts/macros.py rm --last
{baseDir}/scripts/macros.py rm --index 2   # remove the 2nd entry (use `entries` to find the number)
```

`edit` changes only the fields you pass and keeps the rest (time, note, untouched macros) - safer than delete-and-retype. Select with `--last` or `--index N` (from `entries`), like `rm`. It can't re-scale a saved food to a new gram amount (the entry isn't linked back to the food); for that, `rm` then `food-eat` again.

## Meal prep (batch cooking)

A batch is built up ingredient by ingredient. It tracks its ingredient list plus how much has left it, split into what **you** ate (logged to your day) and what left **unlogged** (someone else ate it, a spill, a giveaway), so `remaining = total - your share - the unlogged share`. Create it, then add ingredients one message at a time (look each up or estimate it, exactly like logging food):

```bash
{baseDir}/scripts/macros.py prep-add --name "Bolognese"                        # create an empty batch
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label "Beef mince (500g)" --kcal 1075 --protein 100 --fat 75 --carbs 0
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label "Passata (700g)" --kcal 245 --protein 12 --fat 1 --carbs 45
{baseDir}/scripts/macros.py prep-get --name bolognese                          # ingredient breakdown, total, % left (with your/others split)
```

`prep-add` makes an empty batch and refuses a name that already exists (so you never wipe a half-eaten one); a batch whose total you already know is just `prep-add` plus one `prep-ingredient-add`.

**Eating vs unlogged removal** - the key pair. `prep-eat` is a portion **you** eat (logged to your day); `prep-rm` is a portion that leaves the batch **unlogged**:

```bash
{baseDir}/scripts/macros.py prep-eat --name bolognese --fraction 1/5    # you ate 1/5 of the WHOLE batch (also 20% or 0.2)
{baseDir}/scripts/macros.py prep-eat --name bolognese --remaining       # you finish whatever is left
{baseDir}/scripts/macros.py prep-eat --name bolognese --fit-protein     # enough to reach today's protein goal
{baseDir}/scripts/macros.py prep-eat --name bolognese --target-kcal 500 # a portion worth 500 kcal
{baseDir}/scripts/macros.py prep-rm --name bolognese --fraction 1/3     # someone else ate / spilled / gave away 1/3 - NOT your intake
{baseDir}/scripts/macros.py prep-rm --name bolognese                     # discard the WHOLE batch (spoiled/scrapped)
{baseDir}/scripts/macros.py prep-list                                   # each batch with its remaining kcal/protein
```

`--fraction` (on both) is a share of the whole batch, not of what remains, and errors if it exceeds what's left; use `prep-eat --remaining` to eat the rest, or `prep-rm` with no `--fraction` to bin the batch. `prep-eat`'s `--fit-*`/`--target-*` size the portion for you and cap to what remains.

### Adding an ingredient after eating some

Adding to a batch that's already been eaten from has two cases; the flag depends on what actually happened:

- **Forgot to mention it** (it was in the pot all along) - the default. The share already eaten is split back correctly (your part is logged so your intake stays right, anyone else's isn't), and the rest joins what's left.
- **Added it to the leftovers** just now (`--later`) - none of it was in what was eaten, so all of it joins what's left and nothing is logged.

```bash
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label "Olive oil (30ml)" --kcal 265 --fat 30                        # forgot it - was in the whole batch
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label "Grated cheese (50g)" --kcal 200 --protein 12 --fat 16 --later # stirred into the leftovers
```

Pick from the wording: "I forgot it also had X" / "X was in it" is the default; "I added / stirred in / topped it up with X" is `--later`. Before anything has been eaten the two are identical, so while you're still building a batch just add ingredients normally. If it's genuinely unclear which applies for a batch that's been eaten from, ask.

### Fixing an ingredient

Use `prep-get` to see each ingredient's index, then correct or drop one by `--index N` (or `--last` for the one you just added) - no rebuild needed:

```bash
{baseDir}/scripts/macros.py prep-ingredient-edit --name bolognese --last --kcal 1000   # fix a wrong number; only what you pass changes, also --label
{baseDir}/scripts/macros.py prep-ingredient-rm --name bolognese --index 3              # drop a mis-added ingredient
```

Before anything's been eaten this just adjusts the batch. If some has been eaten, the correction is applied exactly like a forgotten add in reverse: your already-eaten share of the change is corrected on today's log (a fix can show as a small negative entry), and the rest just adjusts the batch. Pass `--no-log-eaten` to skip touching the day.

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
