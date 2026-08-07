import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";

/**
 * Every skill Apollo ships has to actually load.
 *
 * pi reads each SKILL.md's frontmatter with a real YAML parser and drops the skill when that throws,
 * saying nothing about it. So a skill can be written, symlinked into place, deployed and simply not
 * be there - with the service healthy, the file present and every other check green. Nothing else in
 * this suite looks at a SKILL.md, which is exactly how that gets missed.
 */

const SKILLS_DIR = join(import.meta.dir, "../agent/skills");

const skills = readdirSync(SKILLS_DIR).filter((name) =>
  statSync(join(SKILLS_DIR, name)).isDirectory(),
);

interface SkillFrontmatter extends Record<string, unknown> {
  description?: unknown;
  name?: unknown;
}

describe("shipped skills", () => {
  it("are found where the setup script links them from", () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it("a colon in an unquoted description is what silently unloads one", () => {
    // The failure this whole file exists for: YAML reads `sentence: how` as a nested mapping.
    const colon =
      "---\nname: x\ndescription: Use when it is a shape rather than a sentence: how it flows.\n---\n\nbody";
    expect(() => parseFrontmatter(colon)).toThrow();
    const hyphen = colon.replace("sentence:", "sentence -");
    expect(() => parseFrontmatter(hyphen)).not.toThrow();
  });

  for (const name of skills) {
    describe(name, () => {
      const path = join(SKILLS_DIR, name, "SKILL.md");
      const read = () => parseFrontmatter<SkillFrontmatter>(readFileSync(path, "utf8")).frontmatter;

      it("has a SKILL.md", () => {
        expect(existsSync(path)).toBe(true);
      });

      it("has frontmatter pi can parse", () => {
        expect(() => read()).not.toThrow();
      });

      it("is named after its directory, so it resolves to what the agent was told to load", () => {
        expect(read().name).toBe(name);
      });

      it("says what it is for, so the agent knows when to reach for it", () => {
        const { description } = read();
        expect(typeof description).toBe("string");
        expect((description as string).trim().length).toBeGreaterThan(20);
      });
    });
  }
});
