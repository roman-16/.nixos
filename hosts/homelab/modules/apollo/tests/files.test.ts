import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "bun:test";

import { createFileStore, fileId, safeName } from "../src/files";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "apollo-files-"));
  return { dir, store: createFileStore(join(dir, "files")) };
}

/** A file already in the store, aged by hand so retention can be tested. */
function place(target: ReturnType<typeof store>, waId: string, name: string, daysAgo = 0): string {
  const path = target.store.slot(waId, name);
  writeFileSync(path, "contents");
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  utimesSync(dirname(path), when, when);
  return path;
}

describe("fileId", () => {
  it("is the same for the same message, so a redelivery lands in the same place", () => {
    expect(fileId("3A2F9C")).toBe(fileId("3A2F9C"));
  });

  it("is different for different messages", () => {
    expect(fileId("3A2F9C")).not.toBe(fileId("3A2F9D"));
  });

  it("is a short, path-safe name", () => {
    expect(fileId("3A2F9C")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("safeName", () => {
  it("keeps an ordinary name exactly as the user had it", () => {
    expect(safeName("Bike Handbook (2026).pdf")).toBe("Bike Handbook (2026).pdf");
  });

  it("keeps non-latin names", () => {
    expect(safeName("Grüße und Ölwechsel.txt")).toBe("Grüße und Ölwechsel.txt");
  });

  it("takes only the name out of anything shaped like a path", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\x\\scan.pdf")).toBe("scan.pdf");
  });

  it("never leaves a name that climbs out of its directory", () => {
    expect(safeName("..")).toBe("file");
    expect(safeName("....")).toBe("file");
  });

  it("drops control characters", () => {
    expect(safeName("no\u0000tes\u001b.md")).toBe("notes.md");
  });

  it("falls back when nothing usable is left", () => {
    expect(safeName("")).toBe("file");
    expect(safeName("   ")).toBe("file");
    expect(safeName("/", "video.mp4")).toBe("video.mp4");
  });

  it("shortens a name the filesystem would refuse, keeping the extension", () => {
    const name = safeName(`${"a".repeat(400)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("createFileStore", () => {
  it("gives each file a directory of its own, under its own name", () => {
    const target = store();
    const path = target.store.slot("3A2F9C", "Handbook.pdf");
    expect(path.endsWith(`${fileId("3A2F9C")}/Handbook.pdf`)).toBe(true);
    expect(existsSync(dirname(path))).toBe(true);
  });

  it("keeps two files of the same name apart", () => {
    const target = store();
    expect(target.store.slot("A", "scan.pdf")).not.toBe(target.store.slot("B", "scan.pdf"));
  });

  it("puts a redelivered message back in the same place, leaving no second copy", () => {
    const target = store();
    place(target, "3A2F9C", "Handbook.pdf");
    place(target, "3A2F9C", "Handbook.pdf");
    const root = join(target.dir, "files");
    expect(readdirSync(root)).toHaveLength(1);
    expect(readdirSync(join(root, fileId("3A2F9C")))).toEqual(["Handbook.pdf"]);
  });

  it("never lets a name land outside the store", () => {
    const target = store();
    const path = target.store.slot("3A2F9C", "../../escaped.pdf");
    expect(path.startsWith(join(target.dir, "files"))).toBe(true);
    expect(path.endsWith("escaped.pdf")).toBe(true);
  });

  it("forgets what is past the retention window and keeps the rest", () => {
    const target = store();
    place(target, "old", "gone.pdf", 40);
    const kept = place(target, "new", "kept.pdf", 2);
    expect(target.store.prune(Date.now() - 30 * 86_400_000)).toBe(1);
    expect(existsSync(kept)).toBe(true);
    expect(readdirSync(join(target.dir, "files"))).toEqual([fileId("new")]);
  });

  it("prunes nothing when nothing is old enough", () => {
    const target = store();
    place(target, "new", "kept.pdf");
    expect(target.store.prune(Date.now() - 30 * 86_400_000)).toBe(0);
  });

  it("has nothing to prune before the first file ever arrives", () => {
    const target = store();
    expect(target.store.prune(Date.now())).toBe(0);
  });

  it("leaves anything that is not a stored file alone", () => {
    const target = store();
    place(target, "new", "kept.pdf");
    const root = join(target.dir, "files");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "stray.txt"), "not mine");
    target.store.prune(Date.now());
    expect(existsSync(join(root, "stray.txt"))).toBe(true);
  });
});
