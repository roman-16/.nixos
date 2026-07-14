---
name: obsidian
description: Read and write Roman's Obsidian vault - notes, recipes, journal, philosophy, psychology, projects, rooms, and more. Use whenever the user asks about their notes, vault, or Obsidian, mentions a recipe/journal/note, or asks to look something up in, add to, or update the vault.
---

# Obsidian

Roman's Obsidian vault is a git-backed folder of Markdown notes, cloned at `$APOLLO_WORKSPACE/obsidian`. Sync it through the script below - never run git against it by hand.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

## Sync before you read

Before reading anything from the vault, pull once so you have the latest (this also clones it the first time):

```bash
{baseDir}/scripts/obsidian.sh pull
```

Then read notes with the normal `read` tool and search with `rg` under `$APOLLO_WORKSPACE/obsidian`. One pull covers the whole vault - don't pull again for each file in the same task.

## Save after you write

Once you've finished creating or editing notes, commit and push in one step:

```bash
{baseDir}/scripts/obsidian.sh save
```

It stages everything, commits with a timestamp, and pushes (and prints `Nothing to save.` when there's nothing to commit). Relay its output. Save once you're done, not after every file.

## Follow the folder's Brief

Before writing in a folder, look for a `*Brief*.md` in it (e.g. `Recipes/Editorial Brief.md`). If one exists, read it and follow it: a Brief governs _how_ to write there (tone, structure, formatting, conventions), never _what_ to write. The vault carries its own conventions this way, so there's no separate list to memorise.

## Obsidian syntax

Standard Markdown plus these extensions:

**Links & embeds** - `[[wikilinks]]` for notes inside the vault (Obsidian tracks renames), `[text](url)` for external URLs only. Prefix with `!` to embed inline.

```
[[Note]]        [[Note|shown text]]     [[Note#Heading]]     [[Note#^block-id]]
![[Note]]       ![[Note#Heading]]       ![[image.png|300]]   ![[doc.pdf#page=3]]
```

Define a block anchor by appending `^block-id` to a paragraph (or on its own line after a list/quote).

**Callouts** - `> [!type] Optional title`; foldable with `-` (collapsed) or `+` (expanded); nestable.

```
> [!warning] Heads up
> Body text.

> [!tip]- Folded by default
> Hidden until expanded.
```

Types: note, abstract/summary, info, todo, tip/important, success, question/faq, warning, failure, danger/error, bug, example, quote.

**Frontmatter (properties)** - YAML at the very top of the file:

```yaml
---
tags:
  - recipe
aliases:
  - Other Name
---
```

Built-ins: `tags`, `aliases`, `cssclasses`. Any other key is a custom property (text, number, checkbox, date, list, or a `"[[link]]"`).

**Inline** - `#tag` and `#nested/tag`, `==highlight==`, `%%hidden comment%%`, footnotes `text[^1]` / `^[inline]`, math `$e^{i\pi}+1=0$` and `$$ ... $$` blocks, and ` ```mermaid ` diagrams.

## Naming

No emojis in file or folder names - plain text only (`Recipes/`, not `🧑‍🍳 Recipes/`).
