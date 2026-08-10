import { describe, expect, it } from "bun:test";

import {
  claudeAuthNotice,
  claudeErrorNotice,
  deliveredMarker,
  failedMarker,
  formatLogNotice,
  isAllowed,
  jidForNumber,
  numberFromJid,
  skillContextNote,
  splitInternal,
  splitMessage,
  splitUserContext,
  voiceText,
} from "../src/messages";

describe("splitInternal", () => {
  it("leaves an ordinary message untouched", () => {
    expect(splitInternal("logged it, 420 kcal left")).toEqual({
      delivered: "logged it, 420 kcal left",
      internal: [],
    });
  });

  it("delivers nothing when the block is only a note", () => {
    expect(splitInternal("<internal>macros already sent the summary</internal>")).toEqual({
      delivered: "",
      internal: ["macros already sent the summary"],
    });
  });

  it("keeps the reply and holds back a note appended to it", () => {
    expect(
      splitInternal("Done \u2705\n\n<internal>the summary went out via macros</internal>"),
    ).toEqual({ delivered: "Done \u2705", internal: ["the summary went out via macros"] });
  });

  it("holds back a note written before the reply", () => {
    expect(splitInternal("<internal>checked the ledger first</internal>\nAll good.")).toEqual({
      delivered: "All good.",
      internal: ["checked the ledger first"],
    });
  });

  it("collects several notes in order", () => {
    expect(splitInternal("<internal>one</internal>hi<internal>two</internal>").internal).toEqual([
      "one",
      "two",
    ]);
  });

  it("treats a forgotten closing tag as running to the end, so no markup leaks", () => {
    expect(splitInternal("<internal>nothing to add")).toEqual({
      delivered: "",
      internal: ["nothing to add"],
    });
  });

  it("drops an empty note without recording it", () => {
    expect(splitInternal("<internal></internal>")).toEqual({ delivered: "", internal: [] });
  });

  it("delivers a block that only mentions the word internal", () => {
    const text = "that is an internal detail";
    expect(splitInternal(text).delivered).toBe(text);
  });
});

describe("splitUserContext", () => {
  it("leaves an ordinary message untouched", () => {
    expect(splitUserContext("just a message")).toEqual({
      contexts: [],
      message: "just a message",
    });
  });

  it("separates the app's notes from what the user sent", () => {
    const text =
      '<context source="reply" info="The user is replying to an earlier message.">ty</context>\n\nyo';
    expect(splitUserContext(text)).toEqual({
      contexts: [
        { body: "ty", info: "The user is replying to an earlier message.", source: "reply" },
      ],
      message: "yo",
    });
  });

  it("reads a self-closing note as an empty body and splits several notes", () => {
    const text =
      '<context source="time" info="Sent now." />\n<context source="macros" info="sent">Today: 400 kcal</context>\n\nthanks';
    const { contexts, message } = splitUserContext(text);
    expect(contexts).toEqual([
      { body: "", info: "Sent now.", source: "time" },
      { body: "Today: 400 kcal", info: "sent", source: "macros" },
    ]);
    expect(message).toBe("thanks");
  });

  it("preserves a multi-line body", () => {
    const text = '<context source="macros" info="summary">line1\n\nline2</context>\n\nhi';
    expect(splitUserContext(text).contexts[0]?.body).toBe("line1\n\nline2");
  });

  it("unescapes a quoted attribute value", () => {
    const text = '<context source="time" info="say &quot;hi&quot;" />\n\nyo';
    expect(splitUserContext(text).contexts[0]?.info).toBe('say "hi"');
  });

  it("reverses withContext, so a turn splits back into what it was made of", () => {
    const text = '<context source="time" info="Sent now." />\n\nlog 100g';
    expect(splitUserContext(text).message).toBe("log 100g");
  });
});

describe("deliveredMarker / failedMarker", () => {
  it("tags the delivered marker with the source and the do-not-relay hint", () => {
    const marker = deliveredMarker("macros");
    expect(marker).toContain("[macros: delivered to the user");
    expect(marker).toContain("do not relay");
  });

  it("names how to stay silent, where the decision is made", () => {
    expect(deliveredMarker("macros")).toContain("<internal>");
  });

  it("tags the failed marker with the source and the relay instruction", () => {
    const marker = failedMarker("backup");
    expect(marker).toContain("[backup: delivery FAILED");
    expect(marker).toContain("relay the output");
  });
});

describe("numberFromJid", () => {
  it("strips domain and device suffix", () => {
    expect(numberFromJid("4369912345678@s.whatsapp.net")).toBe("4369912345678");
    expect(numberFromJid("4369912345678:12@s.whatsapp.net")).toBe("4369912345678");
  });
});

describe("jidForNumber", () => {
  it("builds an individual-chat JID and round-trips with numberFromJid", () => {
    expect(jidForNumber("4369912345678")).toBe("4369912345678@s.whatsapp.net");
    expect(numberFromJid(jidForNumber("+43 699 1234 5678"))).toBe("4369912345678");
  });
});

describe("isAllowed", () => {
  const allow = ["4369912345678"];

  it("matches regardless of formatting", () => {
    expect(isAllowed("4369912345678", allow)).toBe(true);
    expect(isAllowed("+43 699 1234 5678", allow)).toBe(true);
  });

  it("rejects unknown or empty numbers", () => {
    expect(isAllowed("4300000000000", allow)).toBe(false);
    expect(isAllowed("", allow)).toBe(false);
    expect(isAllowed("4369912345678", [])).toBe(false);
  });
});

describe("splitMessage", () => {
  it("keeps short text as a single chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns nothing for empty input", () => {
    expect(splitMessage("   ")).toEqual([]);
  });

  it("splits long text into chunks within the limit", () => {
    const line = "word ".repeat(50).trim();
    const text = `${line}\n`.repeat(40).trim();
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("hard-splits a single run with no boundaries", () => {
    const chunks = splitMessage("x".repeat(500), 100);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) expect(chunk.length).toBe(100);
  });
});

describe("voiceText", () => {
  it("prefixes a transcript with the voice marker", () => {
    expect(voiceText("turn on the lights")).toBe("🎤 turn on the lights");
  });

  it("trims surrounding whitespace", () => {
    expect(voiceText("  hello  ")).toBe("🎤 hello");
  });

  it("marks an empty transcript", () => {
    expect(voiceText("   ")).toBe("🎤 (empty voice message)");
  });
});

describe("claudeErrorNotice", () => {
  it("includes the detail and the retry hint", () => {
    const notice = claudeErrorNotice("Overloaded");
    expect(notice).toContain("Overloaded");
    expect(notice).toContain("try again");
  });

  it("omits the detail clause when empty", () => {
    expect(claudeErrorNotice("   ")).toBe(
      "⚠️ I couldn't reach Claude just now. Your message didn't go through - try again in a bit.",
    );
  });

  it("truncates a very long detail", () => {
    expect(claudeErrorNotice("x".repeat(500))).toContain("more chars");
  });

  it("keeps the reason and leaves the stack behind it out", () => {
    const notice = claudeErrorNotice(
      "Overloaded\n    at postJson (/nix/store/x/anthropic.js:155:19)\n    at async refresh",
    );
    expect(notice).toContain("Overloaded");
    expect(notice).not.toContain("nix/store");
  });
});

describe("claudeAuthNotice", () => {
  it("names the one action that fixes it, and where", () => {
    const notice = claudeAuthNotice("https://apollo.halerc.xyz");
    expect(notice).toContain("expired");
    expect(notice).toContain("https://apollo.halerc.xyz");
    expect(notice).toContain("Authorize");
  });

  it("never tells the user to try again, because retrying cannot work", () => {
    expect(claudeAuthNotice("u")).not.toContain("try again");
  });

  it("promises the messages are kept rather than lost", () => {
    expect(claudeAuthNotice("u")).toContain("catch up");
  });

  it("still reads as an instruction without a configured address", () => {
    const notice = claudeAuthNotice("");
    expect(notice).toContain("the dashboard,");
    expect(notice).not.toContain("()");
  });
});

describe("formatLogNotice", () => {
  it("formats the level label and message", () => {
    expect(formatLogNotice({ level: 50, msg: "send failed" })).toBe("⚠️ ERROR: send failed");
    expect(formatLogNotice({ level: 40, msg: "heads up" })).toBe("⚠️ WARN: heads up");
  });

  it("appends a concise detail from err/error/detail", () => {
    expect(formatLogNotice({ detail: "the reason", level: 50, msg: "boom" })).toContain(
      "the reason",
    );
    expect(formatLogNotice({ err: { message: "nested" }, level: 50, msg: "boom" })).toContain(
      "nested",
    );
  });
});

describe("skillContextNote", () => {
  it("puts a coherent description in info and the delivered message in the body", () => {
    const note = skillContextNote("reminders", "⏰ get my food");
    expect(note.source).toBe("reminders");
    expect(note.info).toBe("The reminders skill sent the user a message directly.");
    expect(note.body).toBe("⏰ get my food");
  });

  it("drops the old don't-resend hint", () => {
    expect(skillContextNote("macros", "hi").info).not.toContain("resend");
  });

  it("names an image as an image, with its caption as the body", () => {
    const note = skillContextNote("diagram", "how a message reaches you", true);
    expect(note.info).toBe("The diagram skill sent the user an image directly.");
    expect(note.body).toBe("how a message reaches you");
  });

  it("still describes an uncaptioned image as an image", () => {
    const note = skillContextNote("diagram", "", true);
    expect(note.info).toContain("an image");
    expect(note.body).toBe("");
  });

  it("keeps a long (under-cap) message intact in the body", () => {
    const text = "x".repeat(1000);
    const note = skillContextNote("reminders", text);
    expect(note.body).toBe(text);
    expect(note.body).not.toContain("more chars");
  });

  it("truncates only a very long body", () => {
    expect(skillContextNote("macros", "x".repeat(5000)).body).toContain("more chars");
  });
});
