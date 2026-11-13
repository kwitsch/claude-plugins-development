import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

/** Root of the built plugin. */
const plugin = join(import.meta.dirname, "..", "plugin");

/** Reference files under skills/solve; a new one is added here. */
const REFERENCES = [
  "decide",
  "worktree",
  "design",
  "plan",
  "execute",
  "tdd",
  "debug",
  "verify",
  "request-review",
  "receive-review",
  "finish",
];

/**
 * Reads a file of the plugin.
 *
 * @param path - Path relative to the plugin root.
 * @returns The file text.
 */
const read = (path: string) => readFileSync(join(plugin, path), "utf8");

/**
 * Returns the frontmatter block of a markdown file.
 *
 * @param text - File text.
 * @returns The text between the `---` lines, or "".
 */
const front = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

describe("jev-solver", () => {
  it("has solve as the only skill", () => {
    assert.deepEqual(readdirSync(join(plugin, "skills")), ["solve"]);
    const f = front(read("skills/solve/SKILL.md"));
    assert.match(f, /^name: solve$/m);
    assert.match(f, /^description: .{20,}/m);
  });

  for (const ref of REFERENCES) {
    it(`${ref} is a reference file linked from solve by a relative markdown link`, () => {
      assert.ok(existsSync(join(plugin, "skills/solve", `${ref}.reference.md`)));
      assert.ok(read("skills/solve/SKILL.md").includes(`](${ref}.reference.md)`), ref);
    });
  }

  it("references no longer name skills that do not exist", () => {
    for (const ref of ["SKILL", ...REFERENCES.map((r) => `${r}.reference`)]) {
      assert.doesNotMatch(read(`skills/solve/${ref}.md`), /jev-solver:(?!solve)/, ref);
    }
  });

  it("declares jev-api as dependency", () => {
    const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
    assert.ok(manifest.dependencies.includes("jev-api"));
  });

  it("decider agent is opus with xhigh effort", () => {
    const f = front(read("agents/decider.md"));
    assert.match(f, /^name: decider$/m);
    assert.match(f, /^model: opus$/m);
    assert.match(f, /^effort: xhigh$/m);
  });

  it("solve handles --headless through decider and --size", () => {
    const text = read("skills/solve/SKILL.md");
    assert.match(text, /--headless/);
    assert.match(text, /--size=/);
    assert.match(text, /decider/);
    assert.match(text, /AskUserQuestion/);
  });

  it("solve runs /simplify and a leveled /code-review --fix, and ends with a draft PR", () => {
    const text = read("skills/solve/SKILL.md");
    assert.match(text, /`\/simplify`/);
    assert.match(text, /`\/code-review <level> --fix`/);
    assert.match(text, /S `low`, M `medium`, L `high`, XL `xhigh`/);
    assert.match(text, /draft PR/);
  });
});
