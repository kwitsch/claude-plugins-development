import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

/** Root of the built plugin. */
const plugin = join(import.meta.dirname, "..", "plugin");

/** Every skill directory; a new skill is added here. */
const SKILLS = [
  "solve",
  "decide",
  "design",
  "plan",
  "execute",
  "tdd",
  "debug",
  "request-review",
  "receive-review",
  "verify",
  "worktree",
  "finish",
];

/**
 * Reads a skill's SKILL.md.
 *
 * @param skill - Skill directory name.
 * @returns The file text.
 */
const skillText = (skill: string) => readFileSync(join(plugin, "skills", skill, "SKILL.md"), "utf8");

describe("jev-solver skills", () => {
  for (const skill of SKILLS) {
    it(`${skill} has frontmatter with name equal to its directory and a description`, () => {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(skillText(skill))?.[1] ?? "";
      assert.match(front, new RegExp(`^name: ${skill}$`, "m"));
      assert.match(front, /^description: .{20,}/m);
    });
  }

  it("declares jev-api as dependency", () => {
    const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    assert.ok(manifest.dependencies.includes("jev-api"));
  });

  it("solve routes to every phase skill", () => {
    const text = skillText("solve");
    for (const skill of SKILLS.filter((s) => s !== "solve")) {
      assert.ok(text.includes(`jev-solver:${skill}`), skill);
    }
  });
});
