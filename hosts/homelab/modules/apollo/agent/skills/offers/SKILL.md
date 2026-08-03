---
name: offers
description: Watch supermarket products and report the offers running on them. Use whenever the user wants to follow a product ("watch for an offer for Monster Energy", "tell me when X is cheap"), asks whether something is on offer or what it costs right now, or wants to see, change, or stop their watches.
---

# Offers

Follows products the user cares about and reports what is on offer, including deals that have not started yet. Every read and write goes through the CLI; never edit the JSON by hand and never work out prices or dates yourself - the script owns all of it.

The user gets a digest every morning at 09:00 without you being involved: a systemd timer runs `digest` directly. Your job is everything conversational - setting a watch up precisely, answering questions on demand, and keeping the list tidy.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/offers.py <command> [flags]
```

Never say where the offers come from. To the user this is just "offers" - the provider behind it is an implementation detail that may change.

## Replying

Some commands are written for the user, some are machinery for you.

**Written for the user - `digest`, `search`, `watch-list`.** The script posts the output straight to them on WhatsApp (as an "via offers" message) and prints `[offers: delivered to the user ✓ ...]`. When you see that line, **stay silent** - they already have it verbatim, and restating it double-sends. Silence is written, not implied: close the turn with `<internal>…</internal>`, never with a line about staying quiet. Add `--quiet` when you need the numbers in order to answer something yourself; the output is then printed here, nothing is sent, and the last line is `[offers: quiet - not sent to the user]`.

**Machinery for you - everything else** (`config`, `config-set`, `brands`, `retailers`, `watch-add`, `watch-edit`, `watch-rm`). Nothing is ever sent, so the news is yours to deliver: after adding or removing a watch, tell the user in your own words.

If the script prints `[offers: delivery FAILED ...]`, the send didn't happen: relay that output yourself, just this once (the data was still saved - don't re-run the command). It also exits non-zero in that case, because the morning digest runs with nobody watching and a send that silently never happened would be worse than a loud one - so treat the failure as already explained, not as something to investigate.

Lines starting `[offers]` are notes for you alone and are never part of what the user receives. Act on them; never paste them.

## Setup (once)

Offers are regional, so the script needs a postcode. **Ask the user for theirs the first time it comes up, then never again** - it is stored and the morning digest reads it directly.

```bash
{baseDir}/scripts/offers.py config-set --zip 4020
{baseDir}/scripts/offers.py config
```

## Adding a watch

Do this in two steps, because a plain text search is fuzzy - the provider ORs the words together, so "red bull" also matches unrelated drinks. Pinning the watch to a brand makes the daily digest exact.

First look the brand up:

```bash
{baseDir}/scripts/offers.py brands --query "monster energy"
```

```
brands matching "monster energy" at 1010:
  4517	Monster Energy	(1 offer(s))
```

Then pin it:

```bash
{baseDir}/scripts/offers.py watch-add --label "Monster Energy" --brands 4517
```

`--label` is what the user sees and how they refer to the watch later. `--query` defaults to the label; pass it when the two should differ (`--label "Monster" --query "monster energy"`). Add `--retailers` to follow a product at particular shops only - `retailers --query X` lists the ids:

```bash
{baseDir}/scripts/offers.py retailers --query "red bull"
{baseDir}/scripts/offers.py watch-add --label "Milka" --retailers 12769,12747
```

If `brands` returns several plausible matches, ask the user which they meant rather than guessing. If it returns nothing useful, a watch with just a query is fine.

## Answering "is X on offer?"

```bash
{baseDir}/scripts/offers.py search --query "milka" --quiet
{baseDir}/scripts/offers.py search --watch "red bull" --quiet
```

`--watch` reuses a stored watch's pinning (names match forgivingly); `--query` is a one-off and takes `--brands`/`--retailers` too. `--limit` changes how many deals per section (default 4).

Use `--quiet` and answer in your own words when the user asked a question ("is it cheaper at Lidl?", "should I wait?") - that is one message instead of a raw block plus your commentary. Run it plain only when they asked to *see* the offers, and then say nothing after.

## Viewing and changing watches

```bash
{baseDir}/scripts/offers.py watch-list
{baseDir}/scripts/offers.py watch-edit --label "Milka" --retailers 12769     # only what you pass changes
{baseDir}/scripts/offers.py watch-edit --label "Monster" --rename "Monster Energy"
{baseDir}/scripts/offers.py watch-rm --label "Monster Energy"
```

`watch-edit` and `watch-rm` resolve names forgivingly: an exact label wins, else a unique substring, else the closest spelling. When several watches match it asks you to be specific rather than acting on a guess.

## The morning digest

```bash
{baseDir}/scripts/offers.py digest
```

The timer runs this; you only need it if the user asks "what's on offer right now?" across everything they follow. It reports the present state, not what changed - the same deal appears every morning until it expires, which is intended.

```
🏷️ Offers Mon 03.08

*Red Bull*
  €0.99 (3.96/l) · BILLA, BILLA PLUS · until Wed 05.08
    https://www.marktguru.at/leaflets/78640/page/15
  _upcoming:_
  €0.95 (3.80/l) · Lidl · from Thu 06.08
    https://www.marktguru.at/leaflets/78886/page/11
```

`(3.96/l)` is the price per unit, the only fair way to compare a can against a multipack. `💳` means the price needs the shop's loyalty card. The link opens the leaflet page the deal is printed on.

## Notes

- **Watches with nothing on offer are left out entirely**, and when no watch has anything the digest sends nothing at all. Silence means nothing is on offer, never that something failed.
- Deals that have not started yet are listed under `upcoming:` with the date they begin - that is the useful half, since the user learns about a price before it applies.
- Each section shows at most 4 deals, cheapest first, so a popular product cannot flood the message.
- Identical deals are collapsed: one price running at one time across a retail group is a single line listing the shops.
- Expired offers never appear; the provider drops them before the script sees them.
- All dates are the user's local dates. Never re-derive a date from a timestamp yourself - the stored times are UTC and a window opening at 22:00Z is the *next* day here.
- Prices, dates, grouping, and caps are all the script's job. Read its output; never recompute it.
- The script delivers its own replies for `digest`, `search` and `watch-list` (see [Replying](#replying)); don't relay or restate them - that double-sends.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
