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

- **You:** read the message and identify the food and the amount. For a saved food, use `food-eat`; for a batch, `prep-eat`; for something going into a batch, `prep-ingredient-add`; for a one-off whose per-100 nutrition label you can read (a photo or screenshot), use `eat` with the label's per-100 values plus the amount; only when there is no per-100 rate at all (a pure guess from knowledge) do you supply the final macros yourself with `log --note estimated`. The script always does the scaling - never multiply a rate yourself, and never convert one share into another.
- **The script:** does all scaling and portioning, stores entries, computes every total and the balance ledger, and prints the reply to send. It owns every number.

## Replying

Every command has an audience. **By default it is the user**: the script posts its printed output straight to them on WhatsApp (as a "via macros" message) and prints `[macros: delivered to the user ✓ ...]`. When you see that line, **stay silent** - don't repeat, summarize, rephrase, or comment on it. The user already has it verbatim, and restating it double-sends. Silence is written, not implied: close the turn with `<internal>…</internal>`, never with a line about staying quiet.

**`--quiet` makes the audience you.** Every command takes it. The output is printed here, nothing is sent, and the last line is `[macros: quiet - not sent to the user]`. Reach for it whenever you need a number in order to answer something, so your reply is one message in your own words instead of a raw block followed by your commentary.

- **Answering a question** ("how far over am I?", "what did I have yesterday?"): `summary --quiet`, `show --quiet`, `entries --quiet`, `food-get --quiet`. Read as much as you need - it costs the user nothing - then reply once.
- **Showing the user their data** ("show me today"): run it without `--quiet` and say nothing after.
- **Logging several things at once**: log each with `--quiet`, then one plain `show` at the end. One summary instead of one per entry.

Silencing a write makes the news yours to deliver: if you log something quietly, tell the user what you logged. A `--dry-run` is never sent either (it changes nothing); relay it yourself when the user asked "what if", and you may add one short line after, e.g. "Want me to log it?".

One thing `--quiet` cannot hide: **a change to the saved foods**. `food-add`, `food-edit`, `food-rm`, and a food the script saves by itself each state that change to the user whatever else the run kept private - the catalog is their data, so an entry can never arrive unseen. You'll see the line in the output and a delivered marker under it; don't repeat it.

If the script prints `[macros: delivery FAILED ...]`, the send didn't happen: relay that command's output yourself, just this once (the data was still saved - don't re-run the command).

Lines starting `[macros]` after the result are notes for you alone - they are never part of what the user receives. Act on them; never paste them.

## Setup (once, or when targets change)

```bash
{baseDir}/scripts/macros.py goal-set --phase cut --tdee 2400 --daily-goal 2100 --protein 150 --weight-goal 66
{baseDir}/scripts/macros.py goal
```

`daily-goal` is the kcal anchor the ledger steers the multi-day average toward; `tdee` is maintenance and sets the floor. Phase is `cut`, `maintenance`, or `bulk`.

## Logging food (one-off / estimated)

`log` is for entries where you already have the **final** macros and just transcribe them - a pure estimate, or a value the user gives you directly. A food with a readable per-100 label goes through `eat` (below), saved foods through `food-eat`, batches through `prep-eat`; reach for `log` only when none of those fit. `--kcal` is required; `--protein/--fat/--carbs` default to 0; time and date default to now.

```bash
{baseDir}/scripts/macros.py log --item "Chicken breast (250g)" --kcal 413 --protein 77.5 --fat 9 --carbs 0
{baseDir}/scripts/macros.py log --item "Burger and fries" --kcal 900 --protein 40 --fat 45 --carbs 80 --note estimated
```

`log` prints the day summary; the script sends it to the user (see [Replying](#replying)).

## Logging from a nutrition label (photo)

When the user sends a photo or screenshot of a nutrition label - macros **per 100g or 100ml** - together with an amount ("log 235g"), read the per-100 values and the amount off the message and hand both to `eat`. The script scales them (it derives the factor from the amount itself, so 235g becomes x2.35) and logs the result **without saving the food**. You never multiply.

```bash
{baseDir}/scripts/macros.py eat --item "Granola" --kcal100 450 --protein100 10 --fat100 20 --carbs100 55 --amount 235
{baseDir}/scripts/macros.py eat --item "Oat drink" --unit ml --kcal100 46 --protein100 1 --fat100 1.5 --carbs100 6.7 --amount 500
{baseDir}/scripts/macros.py eat --item "Chips" --kcal100 536 --protein100 6 --fat100 32 --carbs100 53 --amount 60 --note estimated
```

`--kcal100` is required; `--protein100/--fat100/--carbs100` default to 0. `--unit` defaults to `g` (set `ml` for liquids, etc.), and the amount and logged label then read in that unit (`235g`, `500ml`). Pass `--note estimated` when the _amount_ is a guess - the label's per-100 numbers stay exact regardless. `eat` prints the day summary; the script sends it to the user (see [Replying](#replying)).

In place of `--amount` it accepts the same `--fit-*`/`--target-*` sizing as `food-eat`, so you can answer "how much of this for my remaining protein?" straight from a photo:

```bash
{baseDir}/scripts/macros.py eat --item "Granola" --kcal100 450 --protein100 10 --fat100 20 --carbs100 55 --fit-protein --dry-run
```

`eat` logs a one-off, and the script checks what you typed against the catalog so you don't have to. Three things may come of it, in order:

- **The rate is already saved** - use `food-eat` next time; same numbers, no transcribing.
- **A saved food already has that name, with different numbers** - you estimated over real label data. It names both values so you can see how far off the guess was; the entry is still logged, so switch to `food-eat` (and remove the estimate) unless it genuinely is a different food.
- **The same rate has now been logged three times** - the script saves it as a food itself and tells the user so. There is nothing for you to run; use `food-eat --name "..."` from then on.

Switching to a saved food is the user's call, so ask before you do it. Saving is not yours at all: it happens by itself once a food has earned it, and otherwise only when the user asks (see below).

## Viewing a day

```bash
{baseDir}/scripts/macros.py show                     # today
{baseDir}/scripts/macros.py show --date 2026-07-12
```

## Averages over a range

For any "average", "last N days", or "this week/month" question, use this - **one call**, never loop `show` and never sum or average days yourself. It averages over the completed logged days in the range; today, still in progress, is shown on its own line and never drags the average down. Unlogged days are skipped, not counted as zero.

```bash
{baseDir}/scripts/macros.py summary                                  # last 7 days
{baseDir}/scripts/macros.py summary --days 30                        # last 30 days
{baseDir}/scripts/macros.py summary --from 2026-06-01 --to 2026-06-30
```

`--days N` counts back from today (`--days 7` is today plus the 6 days before it); `--from`/`--to` give an explicit range (`--to` defaults to today, and the two selectors are mutually exclusive). The output is a ready-to-send summary the script sends to the user (see [Replying](#replying)). When the range contains any weigh-ins it also appends a weight line - the trend (first → latest) plus the average, or just the value for a single one - and a range with only weigh-ins and no food still reports them.

## Saved foods (per 100 of a unit + default serving)

Each saved food stores its macros per 100 of a **unit** - grams by default, or `ml` for liquids, `pieces` for countables, etc. - plus a default serving in that unit. `food-eat` logs one and does the scaling for you - never multiply the per-100 rate by hand. Give an amount, or omit it for the default serving:

```bash
{baseDir}/scripts/macros.py food-eat --name skyr                      # one default serving
{baseDir}/scripts/macros.py food-eat --name skyr --amount 400          # 400 of the food's unit (skyr: g)
{baseDir}/scripts/macros.py food-eat --name beer --amount 500          # 500ml when the food's unit is ml
{baseDir}/scripts/macros.py food-eat --name skyr --servings 2
{baseDir}/scripts/macros.py food-eat --name skyr --fit-protein        # enough to reach today's protein goal
{baseDir}/scripts/macros.py food-eat --name skyr --target-protein 40  # enough to supply 40g protein
```

`--fit-kcal` and `--target-kcal` size by calories the same way. Amounts and the logged label read in the food's unit (`500ml`, `4 pieces`, `500g`). `food-eat` prints the day summary; the script sends it to the user.

`food-get` looks a food up (`--quiet` when you just need the numbers yourself; `food-eat` resolves names itself, so it is never needed as a pre-check); `food-add` saves one and refuses without `--asked`, which says the user asked for this food to be saved, in their own words; `food-edit` corrects a saved food's numbers, unit, or name; `food-rm` deletes one. `--unit` defaults to `g`; set it for liquids/countables and the per-100 values are then per 100 of that unit.

**An entry is only worth having if the food comes back.** A one-off needs no entry - `eat` logs it and scales it just the same - and the catalog fills itself from what actually repeats: the third time the same rate is logged, the script saves it. So there are exactly two ways a food gets in, and neither of them is your judgement - the script decided it had earned it, or the user asked and you passed `--asked`. Saving on first sight is a guess about the future, and those guesses are what fill a catalog with entries nobody ever eats again. `food-list` shows what each entry has earned (`3x, last 09.08`, or `never eaten, saved 04.08`), most eaten first, so anything that never came back collects at the bottom - if the list has filled up with those, offer to clear them out.

```bash
{baseDir}/scripts/macros.py food-get skyr
{baseDir}/scripts/macros.py food-add --name "Skyr, plain" --kcal100 64 --protein100 11 --fat100 0.1 --carbs100 4 --serving 500 --aliases "skyr,my skyr" --asked
{baseDir}/scripts/macros.py food-add --name "Gösser Märzen" --unit ml --kcal100 42 --protein100 0.5 --fat100 0 --carbs100 3.3 --serving 500 --aliases beer --asked   # a liquid: per 100ml, 500ml default
{baseDir}/scripts/macros.py food-edit --name skyr --kcal100 63 --serving 450   # only what you pass changes; also --unit, --rename, --aliases
{baseDir}/scripts/macros.py food-rm --name skyr
{baseDir}/scripts/macros.py food-list                                          # what's saved, most eaten first, with what each has earned
```

Name matching is forgiving: an exact alias wins, else a unique substring, else the closest spelling. On the logging path a lone close match is logged and announced (`read "skyer" as Skyr, plain`); when several foods match it asks you to pick, and `food-edit`/`food-rm` never act on a guess (re-run with the exact name). On a miss, check `food-list`.

## Weight

```bash
{baseDir}/scripts/macros.py weight --kg 66.4
```

A recorded weigh-in is echoed in that day's summary (`Weight 66.4 kg (goal ...)`), even before any food is logged, and is rolled into `summary`'s weight line across a range.

## Fixing mistakes

```bash
{baseDir}/scripts/macros.py entries        # the day's entries with their index numbers
{baseDir}/scripts/macros.py edit --last --amount 300                           # wrong portion: re-scale it
{baseDir}/scripts/macros.py edit --last --kcal 538 --item "Ice cream (215g)"   # fix values in place; only what you pass changes
{baseDir}/scripts/macros.py edit --index 2 --protein 30                        # correct the 2nd entry
{baseDir}/scripts/macros.py rm --last
{baseDir}/scripts/macros.py rm --index 2   # remove the 2nd entry (use `entries` to find the number)
```

`edit` changes only the fields you pass and keeps the rest (time, note, untouched macros) - safer than delete-and-retype. Select with `--last` or `--index N` (from `entries`), like `rm`.

`--amount` re-scales an entry from its own per-100 rate and relabels it, so a misjudged portion is one command - it works for anything logged with `eat` or `food-eat`. An entry made with `log` has no rate behind it (you supplied final macros), so correct those with explicit `--kcal`/`--protein`/`--fat`/`--carbs`.

## Meal prep (batch cooking)

A batch is built up ingredient by ingredient, and everything that leaves it is a **consumption event** in a log: a portion **you** ate (logged to your day) or one that left **unlogged** (someone else ate it, a spill, a giveaway), so `remaining = total - your share - the unlogged share`. Every event is inspectable with `prep-get` and reversible with `prep-uneat`. Create the batch, then add ingredients one message at a time:

```bash
{baseDir}/scripts/macros.py prep-add --name "Bolognese"                        # create an empty batch
{baseDir}/scripts/macros.py prep-add --name "Ice cream" --size 1000            # optional total size (grams; --unit ml/pieces/...)
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --food skyr --amount 400                                    # a saved food, scaled here
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label Passata --kcal100 35 --protein100 1.5 --carbs100 7 --amount 700   # off the packet, scaled here
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label "Olive oil" --kcal 265 --fat 30                     # only the total is known
{baseDir}/scripts/macros.py prep-get --name bolognese                          # ingredients, total, consumption log, % (and size) left
```

**An ingredient is named the same three ways a meal is.** `--food <name> --amount N` for anything saved (the label writes itself, and `--unit` comes from the food); `--kcal100 ... --amount N` when you have the packet in front of you; `--kcal N` only when the total is all there is. As everywhere else, the script does the scaling - never multiply a per-100 rate by an amount to fill in `--kcal`. Amounts read back in the label (`Skyr (plain) (400g)`), and an ingredient scaled from a rate can be re-weighed later with one flag (`prep-ingredient-edit --amount 500`).

`prep-add` makes an empty batch and refuses a name that's already **active** (so you never wipe one you're part-way through) - but a finished batch steps aside (it archives itself, below), so reusing its name for a fresh cook just works; a batch whose total you already know is just `prep-add` plus one `prep-ingredient-add`.

**Eating, unlogged removal, undo** - the core verbs. `prep-eat` is a portion **you** eat (logged to your day); `prep-remove` is one that leaves the batch **unlogged**; `prep-uneat` reverses any event; `prep-archive` files a batch away when you're done (it's never deleted, just kept for lookup), and `prep-unarchive` brings one back:

```bash
{baseDir}/scripts/macros.py prep-eat --name bolognese --of-rest          # you finish whatever is left
{baseDir}/scripts/macros.py prep-eat --name bolognese --of-rest 1/2      # half of what's LEFT (also 50% or 0.5)
{baseDir}/scripts/macros.py prep-eat --name bolognese --of-batch 1/5     # a fifth of the WHOLE batch - a fixed meal-prep serving
{baseDir}/scripts/macros.py prep-eat --name "ice cream" --size 250       # you ate 250g (needs a size set)
{baseDir}/scripts/macros.py prep-eat --name bolognese --fit-protein      # enough to reach today's protein goal
{baseDir}/scripts/macros.py prep-eat --name bolognese --target-kcal 500  # a portion worth 500 kcal
{baseDir}/scripts/macros.py prep-remove --name bolognese --of-rest 1/3   # someone else ate / spilled 1/3 of what's LEFT - NOT your intake
{baseDir}/scripts/macros.py prep-uneat --name bolognese --last          # undo the last event (or --index N from prep-get, or --all)
{baseDir}/scripts/macros.py prep-archive --name bolognese               # done with it - file it away (kept forever, never deleted)
{baseDir}/scripts/macros.py prep-unarchive --name bolognese             # bring an archived batch back (or --id from prep-list --all)
{baseDir}/scripts/macros.py prep-list                                   # active batches (add --all to include archived ones)
```

**A share names its denominator, so say the one the user said.** "Half of it", "a third", "most of what's left", "the rest" are shares of what is currently **left**: `--of-rest <frac>` (bare `--of-rest` = all of it; it errors above 1, being a share of the leftovers). "One of the 5", "a fifth of what I made" is a share of the **whole** batch: `--of-batch <frac>` (it errors if it exceeds what's left). Never convert between the two yourself - pass the share as it was said and let the script do it; on a partly eaten batch `--of-batch` prints what that share is of the rest, so a mis-named denominator shows up at once. `--size` is for absolute grams. Every eat adds a `🥘` line with the batch's remaining before/after (a projection on `--dry-run`), so you always see how full it is - never assume it's full; once a batch is partway down the reply also reframes the portion as its share **of what's left** (e.g. `50% of what's left (30% of batch, ~250g)`). `prep-eat`'s `--fit-*`/`--target-*` size the portion for you and cap to what remains. **Batches are never deleted, only archived** - eating (or removing) a batch down to 0% archives it automatically, and `prep-archive` files one away on demand. Archived batches drop out of `prep-list` (see them with `--all`) but are kept forever for lookup with `prep-get` (by name, or `--id` when several archived batches share a name). To fix a finished batch, `prep-unarchive` it first, then `prep-uneat`/`prep-ingredient-edit`.

### Size (grams / ml / pieces)

A batch optionally carries a total **size** so portions read in real units, not just "% of batch". Set it at creation with `prep-add --size`, or any time after - best measured _after_ cooking/draining, when the real weight is finally known:

```bash
{baseDir}/scripts/macros.py prep-size --name "ice cream" --size 950            # 950g total (measured after freezing)
{baseDir}/scripts/macros.py prep-size --name soup --size 900 --unit ml
{baseDir}/scripts/macros.py prep-size --name "ice cream" --clear               # drop the size again
```

With a size set, every portion also shows its weight and `prep-eat --fit-kcal` answers in grams (`31% of batch (~295g)`, or `46% of what's left (31% of batch, ~295g)` once it's partway down). If asked "how much of X can I eat in grams" and the batch has no size, offer to record one. Size scales with the kcal fraction, so it stays a `~` estimate; if you change the composition a lot, re-run `prep-size`.

### Undoing a consumption mistake

`prep-get` numbers each consumption event; `prep-uneat` reverses one by `--index N`, the most recent with `--last`, or clears the whole log with `--all`. Reversing an **eaten** event also removes the day entry it created and re-folds the ledger; reversing a **removed** event just restores it to the batch. This is the fix for "logged it against the wrong batch": `prep-uneat` the wrong one, then apply it to the right one. `prep-uneat` acts on active batches, so a batch that has been archived (e.g. auto-archived at 0%) must be `prep-unarchive`d first.

### Adding an ingredient after eating some

Adding to a batch that's already been eaten from has two cases; the flag depends on what actually happened:

- **Forgot to mention it** (it was in the pot all along) - the default. The share already eaten is split back correctly (your part is logged so your intake stays right, anyone else's isn't) as adjustment events in the log, and the rest joins what's left.
- **Added it to the leftovers** just now (`--later`) - none of it was in what was eaten, so all of it joins what's left and nothing is logged.

```bash
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --label "Olive oil" --kcal 265 --fat 30                          # forgot it - was in the whole batch
{baseDir}/scripts/macros.py prep-ingredient-add --name bolognese --food "grated cheese" --amount 50 --later                       # stirred into the leftovers
```

Pick from the wording: "I forgot it also had X" / "X was in it" is the default; "I added / stirred in / topped it up with X" is `--later`. Before anything has been eaten the two are identical, so while you're still building a batch just add ingredients normally. If it's genuinely unclear which applies for a batch that's been eaten from, ask.

### Fixing an ingredient

Use `prep-get` to see each ingredient's index, then correct or drop one by `--index N` (or `--last` for the one you just added) - no rebuild needed:

```bash
{baseDir}/scripts/macros.py prep-ingredient-edit --name bolognese --last --amount 500  # re-weigh it: re-scales from its own rate and relabels
{baseDir}/scripts/macros.py prep-ingredient-edit --name bolognese --last --kcal 1000   # fix a wrong number; only what you pass changes, also --label
{baseDir}/scripts/macros.py prep-ingredient-rm --name bolognese --index 3              # drop a mis-added ingredient
```

`--amount` re-scales an ingredient from the per-100 rate it was added with, so "it was 500g not 400g" needs no arithmetic. An ingredient added with `--kcal` alone has no rate behind it, so correct those with explicit macros.

Before anything's been eaten this just adjusts the batch. If some has been eaten, the correction is applied exactly like a forgotten add in reverse: your already-eaten share of the change is corrected on today's log (a fix can show as a small negative entry), and the rest just adjusts the batch. Pass `--no-log-eaten` to skip touching the day.

## Previewing

`log`, `eat`, `food-eat`, and `prep-eat` all take `--dry-run`: it prints the day exactly as it would look with the entry added, but saves nothing - no entry stored, no batch consumed. Use it for "how would my day look" and "how much of X can I eat"; pair it with `--fit-protein` to answer "how much do I need to hit my protein" in a single call.

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

- The macro day rolls over at **04:00**, not midnight: an entry made between 00:00 and 04:00 counts toward the previous calendar date. `today`, `summary`, and the whole rolling balance use this 04:00-based day, while `now_time` still records the real wall-clock time on the entry - so at 02:00, "today" is still yesterday. Pass an explicit `--date` only to override.
- Dates and times come from the system clock; only pass `--date`/`--time` to correct a past entry. Adjusting a day that has already passed (`log`, `edit`, `rm`, `food-eat`, or `prep-eat` with `--date`) reprints today's summary after the changed day, since a past change cascades through the rolling balance and moves today's target (both blocks are sent to the user).
- Estimate freely for vague inputs - a described meal, or a photo with no legible label - and pass `--note estimated`; when a photo _does_ show a per-100 label, use `eat` instead so the script scales it exactly. The totals stay exact regardless.
- Every macro must be non-negative and every amount positive; the script rejects impossible values, so a slip like `--kcal -5` errors out instead of silently corrupting a total.
- For "how much to hit X" or "how would my day look", use `--fit-*`/`--target-*` and `--dry-run` - never work out the amount or the projected totals yourself.
- The script delivers its own replies to the user (see [Replying](#replying)); don't relay or restate them - that double-sends.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
