import { describe, expect, it } from "bun:test";

import { createLogBuffer, filterLogs, parseLevel } from "../src/logs";

describe("parseLevel", () => {
  it("accepts known levels and defaults to all", () => {
    expect(parseLevel("info")).toBe("info");
    expect(parseLevel("warn")).toBe("warn");
    expect(parseLevel("error")).toBe("error");
    expect(parseLevel("all")).toBe("all");
    expect(parseLevel(null)).toBe("all");
    expect(parseLevel("bogus")).toBe("all");
  });
});

describe("createLogBuffer", () => {
  it("captures JSON lines written to the stream and increments seq", () => {
    const buffer = createLogBuffer(10);
    expect(buffer.seq).toBe(0);
    buffer.stream.write(`${JSON.stringify({ level: 30, msg: "hi", time: 1 })}\n`);
    expect(buffer.seq).toBe(1);
    expect(buffer.records()).toEqual([{ level: 30, msg: "hi", time: 1 }]);
  });

  it("ignores non-JSON lines", () => {
    const buffer = createLogBuffer(10);
    buffer.stream.write("not json\n");
    expect(buffer.records()).toEqual([]);
    expect(buffer.seq).toBe(0);
  });

  it("drops the oldest records beyond capacity", () => {
    const buffer = createLogBuffer(2);
    for (const n of [1, 2, 3]) {
      buffer.stream.write(`${JSON.stringify({ level: 30, msg: String(n), time: n })}\n`);
    }
    expect(buffer.records().map((record) => record.msg)).toEqual(["2", "3"]);
  });

  it("push adds a record directly", () => {
    const buffer = createLogBuffer(10);
    buffer.push({ level: 40, msg: "x", time: 5 });
    expect(buffer.records()).toEqual([{ level: 40, msg: "x", time: 5 }]);
  });
});

describe("filterLogs", () => {
  const records = [
    { level: 20, msg: "d", time: 1 },
    { level: 30, msg: "i", time: 2 },
    { level: 40, msg: "w", time: 3 },
    { level: 50, msg: "e", time: 4 },
  ];

  it("returns matching records newest first", () => {
    expect(filterLogs(records, "all").map((record) => record.msg)).toEqual(["e", "w", "i", "d"]);
  });

  it("applies the level threshold", () => {
    expect(filterLogs(records, "info").map((record) => record.msg)).toEqual(["e", "w", "i"]);
    expect(filterLogs(records, "warn").map((record) => record.msg)).toEqual(["e", "w"]);
    expect(filterLogs(records, "error").map((record) => record.msg)).toEqual(["e"]);
  });

  it("skips records without a numeric level", () => {
    const mixed = [{ msg: "no level" }, { level: 50, msg: "e" }];
    expect(filterLogs(mixed, "all").map((record) => record.msg)).toEqual(["e"]);
  });

  it("caps the number of displayed records", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ level: 30, msg: String(i), time: i }));
    expect(filterLogs(many, "all").length).toBe(200);
  });
});
