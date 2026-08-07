---
name: recall
description: Search past WhatsApp conversation with the user - what they sent (text, voice notes, image captions), your past replies, and delivered skill messages. Use whenever the user refers to something from an earlier conversation that isn't in the current thread, asks "what did I say / what did we decide about X", wants an old photo, or you need a fact from before instead of guessing.
---

# Recall

Searches the WhatsApp chat history - and only what actually appeared in the chat: the user's messages (typed text, transcribed voice notes, image captions), your past text replies, and the "via <skill>" messages that were delivered. Your internal machinery - thinking, tool calls and their output, compaction summaries - is never searched, and neither is anything the app wrapped around a message: the `<context>` elements on the user's turns and your own `<internal>` notes are stripped, so a message reads exactly as it did on the phone.

Results are for **you** to read and act on; they are **not** sent to the user, so answer in your own words. Searching is free and fast (a throwaway in-memory index over the local SQLite archive, rebuilt each call), so search whenever you're unsure rather than guessing or saying you don't remember.

Four ways in, one for each kind of question:

- **By content** - `search` - _which_ messages mention this? Trimmed, so a wide net stays cheap.
- **By time** - `history` - what was said at this end of the conversation, or in this stretch of days? Trimmed too.
- **By identity** - `show` - what did these exact messages say? Whole, because a clipped quote is worse than none.
- **By the numbers** - `stats` - how many, how often, since when?

Every call is capped as a whole (~20k characters). If a query is too broad the output stops on a message boundary and says so - narrow it rather than working around it.

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

Keyword search with stemming, so `run` matches `running`. **Nothing you can type is a syntax error**: punctuation belongs to the word, so `col d'Iseran`, `e-mail` and `50%` search for themselves, and filler words are ignored, so pasting the gist of a question still lands on the message it is about. Sharp, few words still beat a whole sentence.

- OR together synonyms and variants: `car OR vehicle OR automobile`.
- Use a trailing `*` for partial words: `dent*`.
- `"quoted phrase"` matches an exact phrase; `AND` / `NOT` combine terms.
- When no message holds _all_ your words, the search widens to any of them and says so. Read those hits as the closest thing, not as the answer.
- If they're still thin, retry with different terms - it costs nothing.

Each hit prints `[#id] date · who: …snippet…` and flags any images. `--since`/`--until` (YYYY-MM-DD) bound the range.

```bash
{baseDir}/scripts/recall.py search "bike service" --full          # whole messages, not snippets
{baseDir}/scripts/recall.py search "bike service" --sort time     # oldest first, for a narrative
```

`--sort time` only changes the order hits are shown in; `--limit` still selects the most relevant ones. To reconstruct how something developed, bound it with `--since`/`--until` and raise `--limit`, then read it chronologically.

## Reading messages in full

```bash
{baseDir}/scripts/recall.py show --ids 1234                  # one message, whole
{baseDir}/scripts/recall.py show --ids 254,260,791           # several at once, in one call
{baseDir}/scripts/recall.py show --ids 1234 --context 5      # plus the 5 messages either side
```

This is how you quote or reconstruct anything: text is never truncated here. Targets are marked with `→`, `…` marks a jump between separate stretches of chat, and `--context` (default 0) widens each id into its surroundings when you need to see what was being discussed.

Ids are shared with entries that never reached WhatsApp (thinking, tool calls), so a stretch of ids will sometimes include one that isn't a message. That is not an error: you get every id that resolved, plus a line naming the ones skipped. Only a request where nothing resolved fails.

## Browsing by time

```bash
{baseDir}/scripts/recall.py history                                    # the last 20 messages
{baseDir}/scripts/recall.py history --last 10 --full
{baseDir}/scripts/recall.py history --first 5                          # the oldest messages there are
{baseDir}/scripts/recall.py history --since 2026-07-13 --until 2026-07-13 --first 50   # one whole day
```

A window on the timeline, always printed in the order things happened. **Say which end you want**: `--last N` counts back from the newest message (the default), `--first N` forward from the oldest. `--since`/`--until` (YYYY-MM-DD) bound the window, and the count applies to whichever end you anchored - so "what was my first message" is `history --first 1`, and a single day is `--since`/`--until` on the same date with `--first`. Trimmed like `search`; add `--full` when you need the wording.

## Counting

```bash
{baseDir}/scripts/recall.py stats                       # the whole archive
{baseDir}/scripts/recall.py stats --since 2026-07-01
{baseDir}/scripts/recall.py stats "dentist"             # how often it comes up, and when it last did
```

For "how many photos have I sent", "how long have we been talking", "how often do I bring this up", "when did I last mention it". It counts exactly the messages the other commands can find, so the numbers always agree with what a search would show you - which is why this is the way to answer a counting question, never a hand-written query against the database.

## View an image

```bash
{baseDir}/scripts/recall.py image --id 1234            # first image on that message
{baseDir}/scripts/recall.py image --id 1234 --index 1  # the 2nd image, if several
```

Writes the stored image to a temp file and prints its path; open that path with your `read` tool to actually see it. Use this to pull up a photo the user sent earlier, or a picture you sent them - find the message first (by caption, date, or `show`), then view the image. The path it prints is also what you hand to the image skill to send that picture again.

## Notes

- Only the WhatsApp-visible transcript is searched; nothing you did internally is, and nothing the app added around a message.
- An image with no caption has no text to match on, so find it via `history` / `show` or a date range, then `image` to view it.
- The `[#id]` in results is the handle for `show` and `image`. Ids are not consecutive - the gaps are internal entries.
- Search to find, `show` to read: don't try to reconstruct a quote from snippets - collect the ids and open them.
- Never paste raw results at the user - they're your notes; use them to answer naturally.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
