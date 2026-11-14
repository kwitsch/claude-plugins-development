import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

/** Root of the built plugin. */
const plugin = join(import.meta.dirname, "..", "plugin");

/** Reference files under skills/solve, found on disk. */
const REFERENCES = readdirSync(join(plugin, "skills/solve")).filter((f) => f.endsWith(".reference.md")).map((f) => f.replace(".reference.md", ""));

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

  it("solve and its references name no removed skills and only link to existing files", () => {
    for (const name of ["SKILL", ...REFERENCES.map((r) => `${r}.reference`)]) {
      const text = read(`skills/solve/${name}.md`);
      assert.doesNotMatch(text, /jev-solver:(?!solve|decider)/, name);
      for (const m of text.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) {
        assert.ok(existsSync(join(plugin, "skills/solve", m[1])), `${name} -> ${m[1]}`);
      }
    }
  });

  it("file questions get a bullet-point summary first (skipped when headless) and an approval loop", () => {
    assert.match(read("skills/solve/SKILL.md"), /summary in bullet points[\s\S]*approve, change, abort[\s\S]*skipped with `--headless`/);
    for (const r of ["design", "spec", "plan"]) assert.match(read(`skills/solve/${r}.reference.md`), /Confirmation\*\* as `solve` describes/, r);
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

  it("decisions due at the same moment are bundled in one batch call", () => {
    assert.match(read("skills/solve/decide.reference.md"), /\*\*Batch first\.\*\*/);
    assert.match(read("skills/solve/SKILL.md"), /task-ambiguity question in the same call/);
    for (const r of ["design", "receive-review", "request-review", "finish"]) {
      assert.match(read(`skills/solve/${r}.reference.md`), /`batch`/, r);
    }
  });

  it("solve dispatches the plugin-namespaced decider agent", () => {
    assert.match(read("skills/solve/SKILL.md"), /subagent_type: jev-solver:decider/);
  });

  it("declares jev-api as dependency", () => {
    const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
    assert.ok(manifest.dependencies.includes("jev-api"));
  });

  it("decider agent is opus with high effort", () => {
    const f = front(read("agents/decider.md"));
    assert.match(f, /^name: decider$/m);
    assert.match(f, /^model: opus$/m);
    assert.match(f, /^effort: high$/m);
  });

  it("solve runs the decider on fable/high for XL", () => {
    assert.match(read("skills/solve/SKILL.md"), /XL with `model: fable`, `effort: high`/);
  });

  it("solve takes --type=<tiny|feature|bugfix> as the track and skips the track question", () => {
    assert.match(read("skills/solve/SKILL.md"), /`--type=<value>`: `tiny`, `feature` or `bugfix`[^\n]*track question of the triage is skipped/);
  });

  it("solve triage has a size floor: functional changes at least M, several functionalities or modules at least L, tiny only for trivial edits", () => {
    const text = read("skills/solve/SKILL.md");
    assert.match(text, /## Size floor/);
    assert.match(text, /at least `M`/);
    assert.match(text, /several functionalities, modules or subprojects[^\n]*at least `L`/);
    assert.match(text, /`tiny` only[^\n]*single file or configuration[^\n]*without significant influence on functionality or tests/);
    assert.match(text, /explicit `--size` is never raised/);
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
