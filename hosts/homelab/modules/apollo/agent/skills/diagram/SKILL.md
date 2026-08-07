---
name: diagram
description: Draw something and send it to the user as a picture on WhatsApp - a flowchart, a sequence, a state machine, a timeline, an entity relationship, a mind map. Use when the answer is a shape rather than a sentence - how something flows, what talks to what, what happens in which order, how a set of things relate.
---

# Diagram

Turns a diagram you write into a picture on the user's phone. You write the source; the script draws it and sends it.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

Always two steps:

1. **Write the source to a file with your `write` tool.** Never through the shell - the quoting will eat the arrows and the newlines.
2. **Render it:**

```bash
{baseDir}/scripts/diagram.py render /tmp/flow.mmd --caption "how a message reaches you"
```

The caption is one short line that sits under the picture. Leave it off when the picture speaks for itself.

`--quiet` draws it and sends nothing, printing where the file landed - use it to check that something renders before you commit to sending it. `--out` puts the PNG somewhere specific.

## Replying

**The script delivers the picture itself**, and prints `[diagram: delivered to the user ✓ ...]`. When you see that line, **stay silent**: the user is looking at the diagram, so narrating it back is noise. Silence is written, not implied - close the turn with `<internal>…</internal>`, never with a line about staying quiet.

If it prints `[diagram: delivery FAILED ...]`, the picture never arrived: say so in your own words.

Everything else it prints is for you alone. Lines starting `[diagram]` are notes about the source you wrote; act on them, never paste them.

## When it is worth a picture

A diagram is a bigger interruption than a message, and it costs the user more attention than a sentence. It earns that only when **the structure is the answer**:

- how something flows, or where a thing goes (architecture, a pipeline, a request path)
- what happens in which order, between which parties (a sequence, a protocol, a handshake)
- what states something can be in, and what moves it between them
- how a set of things depend on or relate to each other
- when things happen relative to one another (a timeline, a plan)

**Do not draw** when a sentence or a short list already answers it, when the user asked in passing, when the content is really numbers (that is a chart, and this is not one), or when you would be drawing a picture of a list. Three boxes in a row is a sentence.

**One line of text with it, not a wall.** The diagram replaces the explanation. If you find yourself sending a diagram _and_ three paragraphs, the paragraphs were the answer and the diagram was decoration.

## Drawing for a phone

The picture is looked at on a screen the size of a hand, in a bubble a few hundred pixels wide. That is a hard constraint on what fits, not a style preference:

- **Top to bottom.** `flowchart TD`, never `LR`. A diagram wider than the page gets squeezed to fit and takes its lettering down with it: the same seven steps drawn sideways come out as a 2952x129 strip nobody can read, and drawn downwards as a legible column. This is the single biggest difference between a diagram that lands and one that wastes a message.
- **Under about ten nodes.** A long chain becomes a thin column that arrives as a stamp and has to be opened. If the subject genuinely needs more, draw the layer above it, or send two.
- **Short labels**, a few words each. Break with `<br/>` rather than letting a box grow wide.
- **No colour scheme.** The house style is black on white, which reads in both light and dark mode. Don't fight it with `style` lines.

The script measures the finished picture and tells you when its proportions will hurt it. That note is worth acting on: it has seen the actual result, and you have not.

## What tends to break

The renderer refuses a diagram it cannot parse, and nothing is sent, so a failure costs you a retry and never reaches the user. The usual causes:

- **A node called `end`** closes a block instead of naming a node. Rename it (`End`, `done`).
- **Brackets or quotes inside a label** end the label early: write `A["a label (like this)"]`.
- **Semicolons and stray punctuation** at the ends of lines, which older mermaid dialects allowed.

Read the parse error, fix the source, render again.

## What you can draw

Flowcharts, sequence diagrams, class diagrams, state diagrams, entity-relationship diagrams, user journeys, gantt charts, pie charts, quadrant charts, requirement diagrams, git graphs, mindmaps, timelines, sankey diagrams, xy charts, block diagrams, packet diagrams, architecture diagrams, radar charts and treemaps.

## Notes

- **The user's vault renders mermaid itself.** A diagram going into Obsidian stays as source in a ` ```mermaid ` fence - never a PNG. This skill is for the chat, where there is nothing to render it.
- The picture is kept in the chat archive like any other, so the recall skill can find it later and the image skill can send it again without redrawing.
- Sending it is the image skill's job, which this calls for you. To send a picture that is not a diagram - a photo from the archive, a page of a document - use that skill directly; this one is only the drawing.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
