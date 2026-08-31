---
name: obsidian
description: Read and write the user's Obsidian vault - notes, recipes, the journal, drafts - and keep it in step with the phone and laptop that edit it too. Use whenever they want something looked up, written down, or changed in their vault ("add this recipe", "what does my X note say", "write that down in Obsidian"), and always after you have edited anything inside it.
---

# Obsidian

The user's vault is a git repo of Markdown notes at `obsidian/` in the workspace. They also edit it from Obsidian on their phone and laptop, where a plugin commits and pulls every few minutes - so it is the one place you work in that somebody else is writing to at the same time.

Writing the notes is your job. Keeping the two sides in step is this skill's, and it is the only thing it does:

```bash
{baseDir}/scripts/obsidian.py sync
```

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

## Never run git in the vault

Not `pull`, not `push`, not `stash`, not `reset`, not `checkout` - not even to look. One badly chosen git command against the vault costs the user notes, so the script owns every one of them, including the recovery from its own failures. If `sync` reports something you don't understand, say so in your own words; never improvise around it.

## Sync before you read, sync when you're done

- **Before you rely on anything in the vault**, sync. The remote moves without you, so an unsynced read is a guess about a note that may have changed on their phone an hour ago.
- **When you have finished writing**, sync - once, at the end, not per file. **An edit you didn't sync hasn't happened**: it sits on this machine and never reaches their phone.
- Syncing when there is nothing to do is free and safe, so sync rather than wonder.

## Reading the report

Its output is for **you**, not the user - nothing is sent to them, so tell them what happened in your own words. Four outcomes:

| Report                                             | What it means                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `the vault is in sync with the remote`             | Nothing was owed. It may name what it `pulled`.                                                                                                                                        |
| `pushed - the vault is in sync`                    | Your work is committed and on its way to their devices.                                                                                                                                |
| `⚠️ could not reach the remote` / `could not push` | Nothing is lost, but nothing arrived either. What you wrote is committed here and the next sync pushes it - so tell them it isn't on their phone yet rather than claiming it is saved. |
| `⚠️ conflict`                                      | They changed the same note you did. See below.                                                                                                                                         |

Every line that names notes says what became of them: a `file` is in the vault now, a `deletion` is gone from it, and a `rename` names the old path and then the new one. So a path listed as a file is a path you can open, and one listed as a deletion is one to stop looking for - if the user asks about a note in neither list, it was never there.

A conflict is not a failure and never needs git: the script leaves the vault clean and holding **their** version, writes **your** version of each clashing note to a file it names, and keeps your commits on a local branch. Read their version in the vault, read yours from that file, write the merged note into the vault, and sync again. Don't discard their edit silently - if the two genuinely disagree, say so and ask.

## Writing notes

- **Read the target folder's `AGENTS.md` before you create or change a note in it.** Each collection has its own brief - what the frontmatter must carry, how ingredients are written, which tone to use - and following it after the fact means rewriting the note. A folder's brief is appended to a read/write in it automatically, but only _after_ the first one, which is too late for a note you are creating.
- **The vault's root `AGENTS.md` is the Obsidian syntax reference** - wikilinks, embeds, callouts, frontmatter, tags, highlights, footnotes, math, mermaid. Read it rather than guessing, and don't hold a remembered copy of it: the user edits it.
- Link notes with `[[wikilinks]]`, never with paths or URLs, so their links keep working when a note is renamed.
- Filenames are the note titles: Title Case, spaces, no extension in links. A new note goes in the folder its collection lives in, not at the root.
- The vault is not your memory. What the user is like belongs in `MEMORY.md`; the vault is their own writing, so put something there only when they want it there.

## Finding things

The vault is small, so plain tools are right for it - just quote paths, because names carry spaces and apostrophes:

```bash
ls "$APOLLO_WORKSPACE/obsidian"                                    # the collections
rg --files "$APOLLO_WORKSPACE/obsidian" --glob '!.obsidian'        # every note
rg --ignore-case "fork seal" "$APOLLO_WORKSPACE/obsidian" --glob '!.obsidian'
```

Then read the note with your `read` tool. Never expand a glob into a `for` loop over unquoted names.

## Attachments

An image the user sent is in the chat archive, not in the vault: find the message with the recall skill, `recall.py image --id <#>` to write it out, then copy it into the vault next to the note and embed it with `![[name.jpg]]`.

## Notes

- `.obsidian/` is the app's own configuration. Never touch it.
- The vault is a separate repo from the workspace, so the 3-hourly workspace backup does **not** cover it. `sync` is the only thing that gets a note off this machine.
- Some folders are frozen or hold raw drafts, and their briefs say so. Respect that over your instinct to tidy.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
