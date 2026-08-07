---
name: image
description: Send a picture to the user on WhatsApp - a photo they asked for, an image from the chat archive, a page of a document, a chart, a screenshot. Use whenever they should look at something rather than read a description of it, or when they ask you to send or show them one.
---

# Image

Sends an image file to the user on WhatsApp. The picture has to be a file on this machine first - found, downloaded, extracted or drawn - and this puts it in front of them.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/image.py send /tmp/receipt.jpg --caption "the one from Tuesday"
```

The caption is one short line under the picture. Leave it off when the picture speaks for itself.

`--source` sets what the chat records the message as - `--source diagram` reads as "via diagram". Leave it alone unless another skill is sending through this one.

There is no way to run this without sending: sending is all it does. PNG, JPEG, WEBP and GIF are what WhatsApp will show as a photo.

## Replying

**The script sends the picture itself** and prints `[image: delivered to the user ✓ ...]`. When you see that line, **stay silent**: the user is looking at it, so describing it back is noise. Silence is written, not implied - close the turn with `<internal>…</internal>`, never with a line about staying quiet.

If it prints a failure instead, the picture never arrived: say so in your own words. A file that cannot be sent is reported as itself (`cannot send /tmp/x.pdf: ...`) - fix that and try again, rather than telling the user something went wrong.

## When it is worth a picture

**When looking at the thing is the answer**: a photo they asked you to find, the label off a jar they sent last month, the page of a document that holds the number, a chart, a map, a diagram.

**Not** when you could just write it. A screenshot of text is worse than the text: it cannot be searched, quoted or read aloud, and it arrives as something to squint at. If the content is words, send words.

**Not** as decoration alongside an answer that was already complete.

One picture per message, and one line with it at most.

## Where pictures come from

- **The chat archive** - the recall skill's `image` command writes a stored picture out to a temp file and prints the path. That path is what you send here, which is how "send me that photo again" works.
- **A drawing** - the diagram skill, which renders and sends in one step. Don't draw a diagram by hand and send it through here.
- **A document** - `pdftoppm` renders a PDF page to an image; `magick` crops, resizes and converts.
- **The web** - `curl` for something you found, and the browser skill takes screenshots.

Anything you send is recorded in the chat like any other message, so it can be found again later rather than re-fetched.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
