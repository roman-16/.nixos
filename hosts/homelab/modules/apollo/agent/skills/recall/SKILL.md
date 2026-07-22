---
name: recall
description: Search past WhatsApp conversation with the user - what they sent (text, voice notes, image captions), your past replies, and delivered skill messages. Use whenever the user refers to something from an earlier conversation that isn't in the current thread, asks "what did I say / what did we decide about X", wants an old photo, or you need a fact from before instead of guessing.
---

# Recall

Searches the WhatsApp chat history - and only what actually appeared in the chat: the user's messages (typed text, transcribed voice notes, image captions), your past text replies, and the "via <skill>" messages that were delivered. Your internal machinery - thinking, tool calls and their output, compaction summaries - is never searched.

Results are for **you** to read and act on; they are **not** sent to the user, so answer in your own words. Searching is free and fast (a throwaway in-memory index over the local SQLite archive, rebuilt each call), so search whenever you're unsure rather than guessing or saying you don't remember.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running.

```bash
{baseDir}/scripts/recall.py <command> [flags]
```

## Search

```bash
{baseDir}/scripts/recall.py search "dentist"
{baseDir}/scripts/recall.py search "dentist OR doctor OR appointment" --limit 15
{baseDir}/scripts/recall.py search "bologn*" --since 2026-06-01 --until 2026-06-30
```

**Build the query yourself - don't forward the user's sentence verbatim.** Pull out the substantive keywords (names, nouns, specifics) and drop filler ("what did I", "discuss", "again", "yesterday"). It's keyword search with stemming (so `run` matches `running`), so:

- OR together synonyms and variants: `car OR vehicle OR automobile`.
- Use a trailing `*` for partial words: `dent*`.
- `"quoted phrase"` matches an exact phrase; `AND` / `NOT` combine terms.
- If the hits are thin, just retry with broader or different terms - it costs nothing.

Each hit prints `[#id] date · who: …snippet…` and flags any images. `--since`/`--until` (YYYY-MM-DD) bound the range.

## Context around a hit

```bash
{baseDir}/scripts/recall.py around --id 1234 --context 5
```

Shows the messages before and after `#1234` in the chat (the target marked with `→`), so you can reconstruct what was being discussed around it.

## Recent messages

```bash
{baseDir}/scripts/recall.py recent --limit 20
{baseDir}/scripts/recall.py recent --since 2026-07-01
```

The most recent WhatsApp messages, oldest-to-newest - for "what were we just doing" or scanning a date range.

## View an image

```bash
{baseDir}/scripts/recall.py image --id 1234            # first image on that message
{baseDir}/scripts/recall.py image --id 1234 --index 1  # the 2nd image, if several
```

Writes the stored image to a temp file and prints its path; open that path with your `read` tool to actually see it. Use this to pull up a photo the user sent earlier - find the message first (by caption, date, or `around`), then view the image.

## Notes

- Only the WhatsApp-visible transcript is searched; nothing you did internally is.
- An image with no caption has no text to match on, so find it via `recent` / `around` or a date range, then `image` to view it.
- The `[#id]` in results is the handle for `around` and `image`.
- Never paste raw results at the user - they're your notes; use them to answer naturally.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
