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
  "spec",
  "plan",
  "execute",
  "tdd",
  "debug",
  "verify",
  "request-review",
  "receive-review",
  "pr",
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
      assert.doesNotMatch(read(`skills/solve/${ref}.md`), /jev-solver:(?!solve|decider)/, ref);
    }
  });

  it("every relative markdown link in solve and its references resolves to a file", () => {
    for (const ref of ["SKILL", ...REFERENCES.map((r) => `${r}.reference`)]) {
      for (const m of read(`skills/solve/${ref}.md`).matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) {
        assert.ok(existsSync(join(plugin, "skills/solve", m[1])), `${ref} -> ${m[1]}`);
      }
    }
  });

  it("file-related questions get a bullet-point summary first, skipped when headless", () => {
    assert.match(read("skills/solve/SKILL.md"), /summary in bullet points[\s\S]*skipped with `--headless`/);
    assert.match(read("skills/solve/design.reference.md"), /bullet-point summary[^\n]*`--headless`/);
    for (const r of ["spec", "plan"]) assert.match(read(`skills/solve/${r}.reference.md`), /bullet-point summary[^\n]*`--headless`/);
  });

  it("feature track flow by size: S direct, M plan, L design+plan, XL design+spec+plan, each confirmed", () => {
    const text = read("skills/solve/SKILL.md");
    assert.match(text, /\| S +\| implement directly/);
    assert.match(text, /\| M +\| \[Plan\]\(plan.reference.md\), confirm, implement/);
    assert.match(text, /\| L +\| \[Design\]\(design.reference.md\), confirm, \[Plan\]\(plan.reference.md\), confirm, implement/);
    assert.match(text, /\| XL +\| \[Design\]\(design.reference.md\), confirm, \[Spec\]\(spec.reference.md\), confirm, \[Plan\]\(plan.reference.md\), confirm, implement/);
  });

  it("solve pushes after the first commit, updates the PR per push and ends merge-ready", () => {
    assert.match(read("skills/solve/SKILL.md"), /first commit[\s\S]*draft PR[\s\S]*every push[\s\S]*description/i);
    assert.match(read("skills/solve/SKILL.md"), /merge conflicts[^\n]*resolved[^\n]*merge-ready/);
    const pr = read("skills/solve/pr.reference.md");
    assert.match(pr, /gh pr create --draft/);
    assert.match(pr, /gh pr edit --body/);
    assert.match(pr, /gh pr ready/);
  });

  it("jev-api comes first for every decision, with a catalogue in decide", () => {
    assert.match(read("skills/solve/SKILL.md"), /jev-api first/);
    const decide = read("skills/solve/decide.reference.md");
    assert.match(decide, /jev-api first/);
    assert.match(decide, /## Catalogue: where jev-api decides/);
    for (const where of ["design", "plan", "execute", "request-review", "receive-review", "worktree", "pr", "finish"]) {
      assert.ok(decide.includes(`\`${where}\``), where);
    }
  });

  it("solve dispatches the plugin-namespaced decider agent", () => {
    assert.match(read("skills/solve/SKILL.md"), /subagent_type: jev-solver:decider/);
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
