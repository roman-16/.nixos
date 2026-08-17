import { describe, expect, it } from "bun:test";

import { isVoiceNote, mediaName, reconnectDelay } from "../src/whatsapp";

describe("isVoiceNote", () => {
  it("reads a voice note by the flag WhatsApp sets on it", () => {
    expect(isVoiceNote({ mimetype: "audio/ogg; codecs=opus", ptt: true })).toBe(true);
  });

  it("reads one by its codec too, so a missing flag never files it away as an attachment", () => {
    expect(isVoiceNote({ mimetype: "audio/ogg; codecs=opus" })).toBe(true);
    expect(isVoiceNote({ mimetype: "audio/opus", ptt: false })).toBe(true);
  });

  it("does not mistake an audio file for something that was spoken", () => {
    expect(isVoiceNote({ mimetype: "audio/mpeg" })).toBe(false);
    expect(isVoiceNote({ mimetype: "audio/mp4", ptt: false })).toBe(false);
  });

  it("treats an audio message that says nothing about itself as a file", () => {
    expect(isVoiceNote({})).toBe(false);
  });
});

describe("mediaName", () => {
  it("keeps the name the user's file already had", () => {
    expect(mediaName("Bike Handbook.pdf", "application/pdf", "document")).toBe("Bike Handbook.pdf");
  });

  it("builds one from what it is when WhatsApp carries none, as for a video", () => {
    expect(mediaName(undefined, "video/mp4", "video")).toBe("video.mp4");
    expect(mediaName("", "application/zip", "document")).toBe("document.zip");
  });

  it("uses the extension people actually use", () => {
    expect(mediaName(null, "audio/mpeg", "audio")).toBe("audio.mp3");
    expect(mediaName(null, "video/quicktime", "video")).toBe("video.mov");
  });

  it("still produces a name when nothing is known about the file", () => {
    expect(mediaName(null, "", "document")).toBe("document.bin");
  });
});

describe("reconnectDelay", () => {
  it("starts at two seconds for the first attempt", () => {
    expect(reconnectDelay(0)).toBe(2000);
  });

  it("doubles with each consecutive failure", () => {
    expect(reconnectDelay(1)).toBe(4000);
    expect(reconnectDelay(2)).toBe(8000);
    expect(reconnectDelay(3)).toBe(16000);
  });

  it("caps at a minute so a long outage keeps re-dialing at a sane rate", () => {
    expect(reconnectDelay(5)).toBe(60000);
    expect(reconnectDelay(100)).toBe(60000);
  });
});
