---
name: files
description: Work with files - the ones the user sends you (a PDF, a zip, a spreadsheet, a video) and the ones you send back to them on WhatsApp. Use whenever a file arrives, whenever the user asks for something as a file or a download, and whenever something has to be moved out of a file into the vault or the working directory.
---

# Files

The user can hand you a file, and you can hand one back. A file is not something you can look at the way you look at a photo - it is an object on this machine, so you open it with your own tools and describe what is in it.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

## A file that arrives

You are told about it on the turn it arrives: the message reads `📎 Handbook.pdf`, and a `<context source="file" ...>` element gives you its full path. Nothing needs to be run to find it - open it where it says.

**Where it landed is a landing zone, not storage.** Received files are deleted after 30 days and are backed up by nothing. So:

- Read it, extract it, work from it - all in place, or in `/tmp/` for anything you unpack.
- **Anything worth keeping, move.** Into `{workspace}` if it is data or notes you will want later, into the vault if it is the user's own writing (obsidian skill). Those two are the things that are backed up.
- Never leave the only copy of something that matters where it landed, and never point a note at that path - it will be gone.

To see what is still there:

```bash
{baseDir}/scripts/files.py list
```

## Opening one

Identify it first - the name is not evidence:

```bash
file --brief "$path"                       # what it actually is
pdftotext "$path" -                        # a PDF as text (poppler)
unzip -l "$path"                           # look inside a zip without unpacking
unzip -q "$path" -d /tmp/unpacked          # unpack it to scratch, never in place
tar --list --file "$path"                  # .tar, .tar.gz, .tar.xz, .tar.zst
7z l "$path"                               # 7z, rar, and most things else
```

Unpack to `/tmp/`, look at what came out, then move only what belongs somewhere into the vault or the working directory. Dumping an archive straight into either is how a vault gets fifty files nobody asked for.

## Sending one

```bash
{baseDir}/scripts/files.py send /tmp/bike-notes.zip --caption "12 notes from your vault"
```

The caption is one short line under the file. Leave it off when the name says everything. Anything up to 100 MB goes; the file has to exist on this machine first, so build it (zip it, export it, render it) and then send it.

## Replying

**The script sends the file itself** and prints `[files: delivered to the user ✓ ...]`. When you see that line, **stay silent**: they have it, and describing it back is noise. Silence is written, not implied - close the turn with `<internal>…</internal>`, never with a line about staying quiet.

A file that cannot be sent is reported as itself (`cannot send /tmp/x: ...`) - fix that and try again rather than telling the user something went wrong. If it prints a delivery failure, the file never arrived: say so in your own words.

`list` is for you alone and is never sent.

## When a file is the right answer

**When they want to keep it, open it elsewhere, or it is not made of sentences**: a document, an export, a set of notes, a picture collection, anything they asked to "send" or "download".

**Not for words they want to read now.** A three-line answer in a file is worse than three lines in the chat: it has to be downloaded and opened to be read. If the content is a message, send a message.

**Not a picture.** A photo, a chart, a page of a document to look at - that is the image skill, which puts it in the bubble where they can see it without downloading anything.

One file per message, and one line with it at most.

## Notes

- The chat records what was exchanged by name and size, not by content, so the recall skill can tell you _that_ a file went either way, and its name, but never give it back. The file itself is on disk while it lasts.
- An archive does not belong in the vault: it is a git repo that syncs to their phone, so everything you put there is downloaded by every device forever. Put the contents in, not the container.
- Nothing you send is deleted from where you built it - clean up `/tmp/` yourself if you filled it.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
