// Structural checks of the built taskflow plugin: manifest, the four skills, the six workflow scripts, the eleven
// agents, the docs, plus the developer notes (taskflow/CLAUDE.md, taskflow/.claude/rules/) and .oxlintrc.json from
// their source paths. Ported from the old bats suite; grep line matches become `m`-flag regexes over the whole text,
// `[[:space:]]` becomes `[ \t]`. Shipped files are read from the built plugin/, so build before testing.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The repository root. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The built plugin, relative to the root. */
const PLUGIN = "taskflow/plugin";
/** The build-task skill. */
const SKILL = `${PLUGIN}/skills/build-task`;
/** The dispatch-task skill. */
const DISPATCH = `${PLUGIN}/skills/dispatch-task`;
/** The review-task skill. */
const REVIEW_TASK = `${PLUGIN}/skills/review-task`;
/** build-task's six usage docs. */
const BT_WF = `${SKILL}/workflows`;
/** The agent files. */
const AGENTS = `${PLUGIN}/agents`;
/** The workflow scripts. */
const WORKFLOWS = `${PLUGIN}/workflows`;
/** The plugin's developer notes (formerly plugins/taskflow/CLAUDE.md). */
const DEV_NOTES = "taskflow/CLAUDE.md";
/** The workflow rule (formerly workflows/CLAUDE.md). */
const WF_RULE = "taskflow/.claude/rules/workflows.md";
/** The dispatch-task rule (formerly skills/dispatch-task/CLAUDE.md). */
const DISPATCH_RULE = "taskflow/.claude/rules/dispatch-task.md";
/** Everything the old suite swept as "the plugin": the shipped files and the developer notes. */
const TREE = [PLUGIN, DEV_NOTES, "taskflow/.claude/rules"];
/** The NO_NARRATION constant every script except design defines. */
const NO_NARRATION_CONST = "const NO_NARRATION = \"No narrative text between tool calls — call tools silently and speak only in your final message (the report or structured output). Write that final message in English, whatever the language of the task or its inputs; commit messages are not covered.\";";
/** German stopwords that must not appear in workflow comments. */
const GERMAN = /\b(und|oder|nicht|wird|werden|auch|sowie|sind|eine|einen|kein|keine|wenn|dass|immer|nie|schritt)\b/i;
/** The six build-task script names. */
const BT_NAMES = ["explore", "design", "spec", "plan", "implement", "ship"];
/** The six usage docs, relative to the build-task skill. */
const USAGE_DOCS = BT_NAMES.map((n) => `workflows/${n}.md`);

/**
 * Absolute path of a repository path.
 *
 * @param rel - Path relative to the repository root.
 * @returns The absolute path.
 */
const abs = (rel: string): string => join(ROOT, rel);

/**
 * Reads a repository file.
 *
 * @param rel - Path relative to the repository root.
 * @returns The file text.
 */
const read = (rel: string): string => readFileSync(abs(rel), "utf8");

/**
 * Whether a file contains a literal string (grep -F).
 *
 * @param rel - Path relative to the repository root.
 * @param s - The literal.
 * @returns True on a match.
 */
const has = (rel: string, s: string): boolean => read(rel).includes(s);

/**
 * Whether a file exists and is not empty (test -s).
 *
 * @param rel - Path relative to the repository root.
 * @returns True when it has content.
 */
const nonEmpty = (rel: string): boolean => existsSync(abs(rel)) && statSync(abs(rel)).size > 0;

/**
 * Number of lines of a file that contain a literal (grep -c).
 *
 * @param rel - Path relative to the repository root.
 * @param s - The literal.
 * @returns The line count.
 */
const countLines = (rel: string, s: string): number => read(rel).split("\n").filter((l) => l.includes(s)).length;

/**
 * File names of a directory with a suffix, sorted.
 *
 * @param rel - Directory relative to the repository root.
 * @param suffix - File name suffix.
 * @returns The names.
 */
const ls = (rel: string, suffix: string): string[] => readdirSync(abs(rel)).filter((f) => f.endsWith(suffix)).sort();

/**
 * Every file below the given paths (files are returned as is).
 *
 * @param rels - Files or directories relative to the repository root.
 * @returns Repository-relative file paths.
 */
function files(rels: string[]): string[] {
  return rels.flatMap((rel) => (statSync(abs(rel)).isDirectory() ? files(readdirSync(abs(rel)).map((n) => `${rel}/${n}`)) : [rel]));
}

/**
 * Files below the given paths that match (grep -r).
 *
 * @param rels - Files or directories relative to the repository root.
 * @param re - The pattern, matched per line.
 * @returns The matching files.
 */
const sweep = (rels: string[], re: RegExp): string[] => files(rels).filter((f) => read(f).split("\n").some((l) => re.test(l)));

/**
 * Escapes a literal for use in a RegExp.
 *
 * @param s - The literal.
 * @returns The escaped pattern.
 */
const lit = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a line containing `head` contains `next` itself or on the line after it (grep -A1 -F head | grep -F next).
 * dprint puts a multi-line arrow body or a `+` continuation on the line after its head.
 *
 * @param head - Literal of the first line.
 * @param next - Literal expected right after it.
 * @param rel - Path relative to the repository root.
 * @returns True on a match.
 */
function followedBy(head: string, next: string, rel: string): boolean {
  const lines = read(rel).split("\n");
  return lines.some((l, i) => l.includes(head) && (l.includes(next) || (lines[i + 1] ?? "").includes(next)));
}

/** The AsyncFunction constructor: its body parser is the Workflow runtime's implicit async wrapper. */
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor as new(body: string) => unknown;

/**
 * Parses a workflow script as an async function body; throws a SyntaxError when it does not parse.
 *
 * @param src - The script text.
 */
function parsesAsAsyncBody(src: string): void {
  new AsyncFunction(src.replace(/^export /m, ""));
}

/**
 * The lines of a section of a markdown file: after the heading line, up to the next `## ` heading.
 *
 * @param rel - Path relative to the repository root.
 * @param heading - The exact heading line.
 * @returns The section text (empty when the heading is missing).
 */
function section(rel: string, heading: string): string {
  const lines = read(rel).split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/**
 * Asserts that a file contains every literal.
 *
 * @param rel - Path relative to the repository root.
 * @param literals - The literals.
 */
function expectHas(rel: string, literals: string[]): void {
  for (const s of literals) expect(has(rel, s), `${rel} should contain ${s}`).toBe(true);
}

/**
 * Asserts that a file contains none of the literals.
 *
 * @param rel - Path relative to the repository root.
 * @param literals - The literals.
 */
function expectLacks(rel: string, literals: string[]): void {
  for (const s of literals) expect(has(rel, s), `${rel} should not contain ${s}`).toBe(false);
}

/**
 * Asserts that no comment text of a workflow script is German (diacritics anywhere, stopwords in `//` comments).
 *
 * @param rel - Path relative to the repository root.
 */
function expectEnglishComments(rel: string): void {
  const text = read(rel);
  expect(text).not.toMatch(/[äöüßÄÖÜ]/);
  const comments = text.split("\n").map((l) => /\/\/.*/.exec(l)?.[0]).filter((c): c is string => c !== undefined);
  expect(comments.filter((c) => GERMAN.test(c))).toEqual([]);
}

describe("manifest", () => {
  const manifest = JSON.parse(read(`${PLUGIN}/.claude-plugin/plugin.json`));
  const pkg = JSON.parse(read("taskflow/package.json"));

  test("plugin.json is valid and has required fields, no userConfig (deliberate — see CLAUDE.md)", () => {
    expect(manifest.name).toBe("taskflow");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest).not.toHaveProperty("userConfig");
  });

  test("package.json and plugin.json versions agree and are 3.0.0", () => {
    expect(pkg.version).toBe("3.0.0");
    expect(manifest.version).toBe(pkg.version);
  });

  test("plugin.json is generated from package.json: claudePlugin is {}, same description, no userConfig", () => {
    expect(pkg.claudePlugin).toEqual({});
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.author).toEqual({ name: "Kwitsch" });
    expect(manifest).not.toHaveProperty("userConfig");
    expect(manifest.description).toBe("Runs a spec-driven design and delivery pipeline for a task (/taskflow:build-task) and reviews and fixes a branch's changes (/taskflow:review-task).");
  });

  test("no design-to-spec mention survives in the plugin or its developer notes", () => {
    expect(sweep(TREE, /design-to-spec/)).toEqual([]);
  });
});

describe("build output", () => {
  test("plugin/bin/ship-ensure-mergeable.mjs exists, is executable and starts with the node shebang", () => {
    const f = `${PLUGIN}/bin/ship-ensure-mergeable.mjs`;
    expect(existsSync(abs(f))).toBe(true);
    expect(statSync(abs(f)).mode & 0o111).not.toBe(0);
    expect(read(f).split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  test("the repository layout check accepts plugin/", () => {
    const r = spawnSync(process.execPath, ["development/scripts/check-plugin-layout.ts", "taskflow"], { cwd: ROOT, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("no CLAUDE.md is shipped in plugin/", () => {
    expect(files([PLUGIN]).filter((f) => f.endsWith("/CLAUDE.md"))).toEqual([]);
  });
});

describe("build-task skill", () => {
  const F = `${SKILL}/SKILL.md`;

  test("build-task SKILL.md exists", () => {
    expect(existsSync(abs(F))).toBe(true);
  });

  test("build-task SKILL.md has name and description frontmatter", () => {
    expect(read(F)).toMatch(/^name:[ \t]*build-task/m);
    expect(read(F)).toMatch(/^description:/m);
  });

  test("build-task SKILL.md allowed-tools includes Workflow and AskUserQuestion", () => {
    expect(read(F)).toMatch(/^allowed-tools:.*Workflow/m);
    expect(read(F)).toMatch(/^allowed-tools:.*AskUserQuestion/m);
  });

  test("build-task SKILL.md is model-invocable (no disable-model-invocation)", () => {
    expect(read(F)).not.toMatch(/^disable-model-invocation:[ \t]*true/m);
  });

  test("build-task SKILL.md references all six usage reference files", () => {
    expectHas(F, USAGE_DOCS);
  });

  test("all six usage reference files exist and are non-empty; the references/ directory is gone", () => {
    for (const f of USAGE_DOCS) expect(nonEmpty(`${SKILL}/${f}`), f).toBe(true);
    expect(existsSync(abs(`${SKILL}/references`))).toBe(false);
  });

  test("build-task SKILL.md runs all six scripts by name, sizes the task (jev-api or own reasoning) and reviews with review-task", () => {
    expectHas(F, ["Never use `scriptPath`", "taskflow:build-task-<name>", "build-task-explore", "build-task-design", "build-task-spec", "args global is undefined", "select:mcp__jev-api__request", "select:mcp__taskflow__size-task", "mcp__taskflow__size-task", "Size: <result>", "explore-<slug>.md", "The skill never Reads these files", "EXPLORE_PATH", "SIZE", "build-task-plan", "build-task-implement", "build-task-ship", "IMPLEMENT_PATH", "REVIEW_PATH", "PR_BODY_PATH", "implement-<slug>.json", "review-<slug>.json", "pr-body-<slug>.md", "Review level: <level> (size <X>)", "taskflow:review-task", "--size=<SIZE>", "except `REVIEW_PATH`, which the skill writes itself in step 5.3"]);
    expect(read(F)).toMatch(/^allowed-tools:.*"Skill"/m);
    expectLacks(F, ["design-to-spec", "difficulty", "spec-driven-delivery", "SHIP: false", "invoke by name", "build-task-review", "escalatedToUser", "ponytailReview", "workflows/review.md"]);
    expect((read(F).match(/\n/g) ?? []).length).toBeLessThan(500);
  });

  test("build-task SKILL.md runs the spec as step 4, after the intent confirmation; Deliver is step 5, the report step 6", () => {
    expectHas(F, ["(Design → Intent confirmation → Spec →", "3. **Intent confirmation.**", "4. **Spec.** Runs once, after the \"Yes\" of step 3.", "5. **Deliver.**", "6. **Report.**", "checkpoint on the design; the spec (step 4) is written from the approved", "as `PLUGIN_ROOT` (step 5.4)", "create-or-update, step 5)", "(steps 2 and 5)", "design and step 5 calls", "step 6 then reports", "(step 6): the spec shipped without"]);
    expectLacks(F, ["step 2.5", "5. **Spec.**", "4. **Deliver.**", "5. **Escalations & report.**", "(step 4.4)", "does the spec count as", "6. **Escalations & report.**"]);
    expectHas(`${BT_WF}/spec.md`, ["build-task runs this script once, after the user confirmed the design intent (SKILL.md step 4); intent corrections re-run only the design script."]);
    expectLacks(`${BT_WF}/spec.md`, ["re-runs the design script and then"]);
    expect(existsSync(abs(`${BT_WF}/review.md`))).toBe(false);
  });

  test("build-task design-pipeline usage references exist and document their contracts", () => {
    for (const f of ["explore.md", "design.md", "spec.md"]) {
      expect(nonEmpty(`${BT_WF}/${f}`), f).toBe(true);
      expectHas(`${BT_WF}/${f}`, ["taskflow:build-task-", "args global is undefined", "const args = { … }", "stage: 'args'"]);
      expectLacks(`${BT_WF}/${f}`, ["claude-opus-4-8", "design-to-spec"]);
    }
    expectHas(`${BT_WF}/explore.md`, ["`TASK`", "`EXPLORE_PATH`", "`GRAPHMIND_AVAILABLE`", "`REPO_PATH`", "`explorePath`", "`subsystems`", "haiku"]);
    expectHas(`${BT_WF}/design.md`, ["`EXPLORE_PATH`", "`DRAFT_PATH`", "`SIZE`", "`RESUME`", "`USER_INPUT`", "`user_input_required`", "`minorFindings`", "fable", "`GRAPHMIND_AVAILABLE` only adds a hint to the designer and design-reviewer prompts"]);
    expectHas(`${BT_WF}/spec.md`, ["`DRAFT_PATH`", "`SPEC_PATH`", "`specPath`", "`specReviewed`", "`minorFindings`"]);
  });

  test("build-task routes every decision through taskflow:decide and forwards --headless", () => {
    expect(read(F)).toMatch(/^argument-hint: "\[--skip-branch-check\] \[--headless\] \[task-description\]"$/m);
    expect(read(F)).toMatch(/^allowed-tools:.*"Agent"/m);
    expectHas(F, ["Skill(skill: \"taskflow:decide\", args: \"[--headless] <JSON>\")", "`DECISIONS:`", "never call `AskUserQuestion` directly", "`$ARGUMENTS` may start with `--skip-branch-check` and/or `--headless`", "context: whyItMatters", "\"id\": \"intent\"", "\"Yes — proceed\", \"No — needs changes\"", "\"id\": \"changes\"", "headless intent check rejected the design without corrections", "headless design did not converge after 3 resumes", "with `--headless ` prepended to `args`", "\"id\": \"reversal-<hash>\"", "`Decided ...`", "(step 3's Keypoints are shown by its decide call)"]);
    expectLacks(F, ["User decisions go through `AskUserQuestion`", "separate, mandatory"]);
    // AskUserQuestion survives only in allowed-tools, the description and the never-call sentence
    for (const l of read(F).split("\n").filter((x) => x.includes("AskUserQuestion"))) expect(l).toMatch(/^allowed-tools:|decide skill \(AskUserQuestion|never call `AskUserQuestion` directly/);
  });
});

describe("workflows/", () => {
  test("every workflow script declares export const meta; spec-driven-delivery is gone", () => {
    for (const n of ls(WORKFLOWS, ".workflow.js")) expectHas(`${WORKFLOWS}/${n}`, ["export const meta = {"]);
    expect(existsSync(abs(`${WORKFLOWS}/spec-driven-delivery.workflow.js`))).toBe(false);
  });

  test("every agentType referenced by the workflows has a matching agents/*.md file", () => {
    for (const f of ls(WORKFLOWS, ".workflow.js").map((n) => `${WORKFLOWS}/${n}`)) {
      const names = new Set([...read(f).matchAll(/taskflow:([a-z-]+)/g)].map((m) => m[1]));
      for (const n of names) expect(existsSync(abs(`${AGENTS}/${n}.md`)), n).toBe(true);
    }
  });
});

describe("build-task scripts", () => {
  test("explore.workflow.js: meta, three phases, args guard, NO_NARRATION on every inline prompt, graphmind path, lens-checked scribe", () => {
    const F = `${WORKFLOWS}/build-task-explore.workflow.js`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["export const meta = {", "name: \"build-task-explore\"", "function decodeArgs", "decodeArgs([\"TASK\", \"EXPLORE_PATH\"], { GRAPHMIND_AVAILABLE: false, REPO_PATH: \"\" })", NO_NARRATION_CONST, "scoutPrompt = `${NO_NARRATION}", "`${NO_NARRATION}\\n\\nYou are a read-only codebase explorer", "seenProposedNames", "explorer: \"haiku\"", "scribe: \"haiku\"", "required: [\"subsystems\"]", "mcp__graphmind__gm_search", "mcp__graphmind__gm_memory_search", "project: \"${REPO}\"", "GRAPHMIND_AVAILABLE=true requires a non-empty absolute REPO_PATH", "{ title: \"Scout\"", "{ title: \"Explore\"", "{ title: \"Scribe\"", "phase(\"Scout\")", "phase(\"Explore\")", "phase(\"Scribe\")", "label: s.name", "label: \"graphmind memory\"", "## Lens: ", "_End of lens: ", "lensHeaders", "lensFooters", "agentType: \"taskflow:explore-scribe\"", "stage: \"Scout\"", "stage: \"Scribe\"", "<<<BEGIN>>>", "label: \"scribe:retry\"", "scribe could not write EXPLORE_PATH", "explorePath: EXPLORE_PATH"]);
    // exactly one phase() call per section: Scout, Explore, Scribe
    expect(countLines(F, "phase(\"")).toBe(3);
    expect(followedBy("graphmindExplorePrompt = (s) =>", "`${NO_NARRATION}\\n\\nYou are a read-only codebase explorer", F)).toBe(true);
    expect(followedBy("graphmindRecallPrompt = () =>", "`${NO_NARRATION}", F)).toBe(true);
    expect(followedBy("explorerPrompt = (s) =>", "`${NO_NARRATION}", F)).toBe(true);
    expectLacks(F, ["difficulty", "resumeNote", "AGENTS", "DRAFT_PATH", "SPEC_PATH", "Task:\\n${TASK}", "explore:", "wc -c", "MIN_WRITE_RATIO", "minBytes", "expectedBytes", "Recorded project knowledge", "scribePrompt = `${NO_NARRATION}"]);
    // the only agentTypes allowed in the explore script: the built-in Explore agent and the Read/Write-only explore scribe
    expect(read(F).split("\n").filter((l) => l.includes("agentType") && !l.includes("agentType: \"Explore\"") && !l.includes("agentType: \"taskflow:explore-scribe\""))).toEqual([]);
  });

  test("build-task design-pipeline scripts parse as async function bodies", () => {
    for (const f of ls(WORKFLOWS, ".workflow.js").filter((n) => n.startsWith("build-task-"))) {
      expect(() => parsesAsAsyncBody(read(`${WORKFLOWS}/${f}`)), f).not.toThrow();
    }
  });

  test("design.workflow.js: args guards, SIZE-keyed designer model, role files by absolute path, inline prompts", () => {
    const F = `${WORKFLOWS}/build-task-design.workflow.js`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["export const meta = {", "name: \"build-task-design\"", "function decodeArgs", "decodeArgs([\"TASK\", \"EXPLORE_PATH\", \"DRAFT_PATH\"], { SIZE: \"\", RESUME: false, USER_INPUT: \"\" })", "RESUME=true requires USER_INPUT", "const DESIGN_MODEL = { S: \"sonnet\", M: \"opus\", L: \"opus\", XL: \"fable\" };", "const designerModel = (s) => DESIGN_MODEL[String(s).toUpperCase()] || \"opus\";", "let DESIGNER_MODEL = designerModel(SIZE);", "model: DESIGNER_MODEL", "designReview: \"sonnet\"", "if (DESIGNER_MODEL !== \"fable\") throw e;", "DESIGNER_MODEL = \"opus\";", "function hasContaminatedKeypoints", "if (d === null || hasContaminatedKeypoints(d))", "never embedded as text/tags", "agentType: \"taskflow:designer\"", "agentType: \"taskflow:design-reviewer\"", "Read the exploration file at ${EXPLORE_PATH} before designing", "per your role", "Apply your full checklist (role definition)", "status: \"user_input_required\"", "Re-run this workflow with RESUME=true, the same DRAFT_PATH and EXPLORE_PATH, and the answers as USER_INPUT (recommended: JSON [{id, answer}]).", "minorFindings: (review.findings || []).filter((f) => f.severity === \"minor\")"]);
    expectLacks(F, ["difficulty", "AGENTS", "ROLE", "SKILL_DIR", "NO_NARRATION", "explorationBlock", "phase(\"Spec\")", "phase(\"Explore\")", "agent definition"]);
  });

  test("spec.workflow.js: spec-writer agent, inline reviewer, English, lean carry-forward, specReviewed", () => {
    const F = `${WORKFLOWS}/build-task-spec.workflow.js`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["export const meta = {", "name: \"build-task-spec\"", "function decodeArgs", "decodeArgs([\"DRAFT_PATH\", \"SPEC_PATH\"], {})", "specWriter: \"sonnet\"", "specReview: \"sonnet\"", "specReviewerPrompt = `${NO_NARRATION}", "function reviewSpec", "function writeSpec", "specReviewed: specCheck != null", "lean/YAGNI decisions forward", "English", "specPath: SPEC_PATH"]);
    expect(followedBy("specWriterPrompt = (revision) =>", "`${NO_NARRATION}", F)).toBe(true);
    expectHas(F, ["agentType: \"taskflow:spec-writer\""]);
    expect(countLines(F, "agentType")).toBe(1);
    expectLacks(F, ["difficulty", "AGENTS", "TASK", "EXPLORE_PATH"]);
    expectHas(`${AGENTS}/spec-writer.md`, ["tools: [\"Read\", \"Write\"]", "with the Write tool", "model: sonnet"]);
  });

  test("build-task scripts: meta, decodeArgs fail-fast, NO_NARRATION, no AGENTS map in explore and spec, clean comments", () => {
    expect(ls(WORKFLOWS, ".workflow.js").filter((n) => n.startsWith("build-task-"))).toHaveLength(6);
    for (const n of BT_NAMES) {
      const f = `${WORKFLOWS}/build-task-${n}.workflow.js`;
      expect(nonEmpty(f), f).toBe(true);
      expectHas(f, ["export const meta = {", "function decodeArgs", "args global is "]);
      expect(read(f)).toMatch(new RegExp(`name:[ \\t]*["']build-task-${n}["']`));
      if (n !== "design") expectHas(f, [NO_NARRATION_CONST]);
      expect(read(f)).toMatch(/stage:[ \t]*["']args["']/);
      expectLacks(f, ["Date.now()", "Math.random()", "new Date()"]);
      if (n === "explore" || n === "spec") expectLacks(f, ["agentType: AGENTS."]);
      expect(read(f)).not.toMatch(/^import /m);
      expectEnglishComments(f);
    }
  });

  test(".oxlintrc.json ignores *.workflow.js (top-level await/return, not a standalone module)", () => {
    expectHas(".oxlintrc.json", ["*.workflow.js"]);
  });

  test("designer and planner role files require English output regardless of input language", () => {
    expect(read(`${AGENTS}/designer.md`)).toMatch(/english/i);
    expect(read(`${AGENTS}/planner.md`)).toMatch(/english/i);
  });
});

describe("agents", () => {
  /** Every shipped agent name, from agents/*.md. */
  const allAgents = (): string[] => ls(AGENTS, ".md").map((f) => f.replace(/\.md$/, ""));

  test("every agent file has a matching name frontmatter", () => {
    for (const a of allAgents()) expect(read(`${AGENTS}/${a}.md`)).toMatch(new RegExp(`^name:[ \\t]*${lit(a)}$`, "m"));
  });

  test("all agent files declare a bare model alias", () => {
    for (const a of allAgents()) expect(read(`${AGENTS}/${a}.md`)).toMatch(/^model: (haiku|sonnet|opus)$/m);
  });

  test("all agent descriptions are INTERNAL ONLY (no model auto-selection)", () => {
    for (const a of allAgents()) expectHas(`${AGENTS}/${a}.md`, ["description: INTERNAL ONLY"]);
  });

  test("all agent files forbid narrative text between tool calls", () => {
    for (const a of allAgents()) expectHas(`${AGENTS}/${a}.md`, ["No narrative text between tool calls"]);
  });

  test("every role file except pr-author requires an English final message", () => {
    const others = ls(AGENTS, ".md").filter((f) => f !== "pr-author.md");
    for (const f of others) expectHas(`${AGENTS}/${f}`, ["Write that final message in English, whatever the language of the task or its inputs; commit messages are not covered."]);
    expect(others).toHaveLength(10);
  });

  test("read-only-declared agents carry a least-privilege tools allowlist without Write/Edit", () => {
    for (const a of ["design-reviewer", "ci-monitor"]) {
      expect(read(`${AGENTS}/${a}.md`)).toMatch(/^tools:/m);
      expect(read(`${AGENTS}/${a}.md`)).not.toMatch(/^tools:.*[ \t,[\]"'](Write|Edit)([ \t,[\]"']|$)/m);
    }
  });

  test("decider: opus at effort high, read-only Read/Grep/Glob, answers as a JSON array", () => {
    const F = `${AGENTS}/decider.md`;
    expectHas(F, ["name: decider", "description: INTERNAL ONLY", "model: opus", "effort: high", "tools: [\"Read\", \"Grep\", \"Glob\"]", "You are read-only: never use Write, Edit, NotebookEdit, or a Bash command that changes files or git state.", "\"answer\": \"<option text verbatim or free text>\""]);
    expect(read(F)).not.toMatch(/^tools:.*(Write|Edit|Bash)/m);
  });

  test("worktree-merger checks the current branch before merging, not primary-vs-worktree", () => {
    const F = `${AGENTS}/worktree-merger.md`;
    expectHas(F, ["Before merging anything"]);
    expect(read(F).toLowerCase()).not.toContain("not a worktree");
  });

  test("build-task SKILL.md stays on the current branch when resuming an existing worktree/PR", () => {
    expect(read(`${SKILL}/SKILL.md`).toLowerCase()).toContain("existing worktree");
  });

  test("build-task SKILL.md documents the --skip-branch-check prefix flag", () => {
    expectHas(`${SKILL}/SKILL.md`, ["--skip-branch-check"]);
  });

  test("build-task SKILL.md allowed-tools includes EnterWorktree", () => {
    expect(read(`${SKILL}/SKILL.md`)).toMatch(/^allowed-tools:.*EnterWorktree/m);
  });

  test("build-task step 1 creates a feature/<slug> worktree via EnterWorktree name", () => {
    const F = `${SKILL}/SKILL.md`;
    expectHas(F, ["EnterWorktree` with `name: \"<slug>\"`", "git branch -m \"feature/<slug>\"", "select:EnterWorktree", "git worktree list --porcelain", "check-ignore -q"]);
    // a path-entered `git worktree add` worktree cannot be removed by ExitWorktree
    expectLacks(F, ["git worktree add", "git checkout -b"]);
  });

  test("taskflow docs describe build-task worktree creation", () => {
    expectHas(DEV_NOTES, ["creates a `feature/<slug>` worktree"]);
    expectHas(`${PLUGIN}/README.md`, ["creates a `feature/<slug>` worktree"]);
    expectHas(DISPATCH_RULE, ["only creates a `feature/<slug>` worktree"]);
  });

  test("ci-monitor collects a rerunId per failed job; ci-fixer consumes it", () => {
    for (const f of [`${AGENTS}/ci-monitor.md`, `${AGENTS}/ci-fixer.md`, `${WORKFLOWS}/build-task-ship.workflow.js`]) expectHas(f, ["rerunId"]);
  });

  test("the designer prompt and role file both disambiguate openQuestions as its own structured-output field", () => {
    expectHas(`${WORKFLOWS}/build-task-design.workflow.js`, ["never embedded as text/tags"]);
    expectHas(`${AGENTS}/designer.md`, ["never write `openQuestions` as text or tags"]);
  });
});

describe("model assignment", () => {
  test("workflow model tiers are unpinned to bare aliases with the size-keyed model maps present", () => {
    expectHas(`${WORKFLOWS}/build-task-design.workflow.js`, ["const DESIGN_MODEL = { S: \"sonnet\", M: \"opus\", L: \"opus\", XL: \"fable\" };", "const designerModel = (s) => DESIGN_MODEL[String(s).toUpperCase()] || \"opus\";", "model: DESIGNER_MODEL"]);
    expectHas(`${WORKFLOWS}/build-task-plan.workflow.js`, ["const PLAN_MODEL = { S: \"sonnet\", M: \"opus\", L: \"opus\", XL: \"fable\" };", "const plannerModel = (s) => PLAN_MODEL[String(s).toUpperCase()] || \"opus\";", "model: PLANNER_MODEL"]);
    expect(sweep([WORKFLOWS], /PINNED_OPUS/)).toEqual([]);
  });

  test("explore scout schema carries no difficulty; the designer model comes from build-task's SIZE", () => {
    expectHas(`${WORKFLOWS}/build-task-explore.workflow.js`, ["required: [\"subsystems\"]"]);
    expectLacks(`${WORKFLOWS}/build-task-explore.workflow.js`, ["difficulty"]);
    expectHas(`${WORKFLOWS}/build-task-design.workflow.js`, ["let DESIGNER_MODEL = designerModel(SIZE)"]);
  });

  test("design.workflow.js designer dispatch falls back from fable to opus on a throw", () => {
    expectHas(`${WORKFLOWS}/build-task-design.workflow.js`, ["if (DESIGNER_MODEL !== \"fable\") throw e;", "DESIGNER_MODEL = \"opus\";"]);
  });

  test("sonnet and haiku workflow assignments stay bare aliases", () => {
    expectHas(`${WORKFLOWS}/build-task-explore.workflow.js`, ["explorer: \"haiku\""]);
    expectHas(`${WORKFLOWS}/build-task-implement.workflow.js`, ["merger: \"haiku\"", "const implModel = (t) => (t.complexity === \"complex\" ? \"opus\" : \"haiku\");"]);
    expectHas(`${WORKFLOWS}/build-task-plan.workflow.js`, ["planChecker: \"sonnet\""]);
  });

  test("the workflow rule's Model assignment section drops the Opus pin and documents the classifier", () => {
    const s = section(WF_RULE, "## Model assignment");
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("claude-opus-4-8");
    expect(s).not.toContain("2026-08-12");
    expect(s.toLowerCase()).not.toContain("exception");
    expect(s).toContain("`sonnet`/`haiku`");
    expect(s).toContain("fable");
  });

  test("README and the design/delivery usage references carry no pinned model ID and name fable", () => {
    for (const f of [`${PLUGIN}/README.md`, `${BT_WF}/design.md`, `${BT_WF}/plan.md`, `${BT_WF}/implement.md`, `${BT_WF}/ship.md`]) expectLacks(f, ["claude-opus-4-8"]);
    for (const f of [`${PLUGIN}/README.md`, `${BT_WF}/design.md`, `${BT_WF}/plan.md`]) expectHas(f, ["fable"]);
  });

  test("no claude-opus-4-8 pin survives anywhere in the plugin or its developer notes", () => {
    expect(sweep(TREE, /claude-opus-4-8/)).toEqual([]);
  });
});

describe("dispatch-task skill", () => {
  const F = `${DISPATCH}/SKILL.md`;

  test("dispatch-task SKILL.md exists and is non-empty", () => {
    expect(nonEmpty(F)).toBe(true);
  });

  test("dispatch-task frontmatter declares name, arguments and the minimal allowed-tools", () => {
    const fm = /^---\r?\n[\s\S]*?\r?\n---/.exec(read(F))?.[0] ?? "";
    expect(fm.length).toBeGreaterThan(0);
    for (const p of ["name: dispatch-task", "arguments: task_description", "\"Bash\"", "\"AskUserQuestion\""]) expect(fm, p).toContain(p);
    for (const p of ["\"Agent\"", "\"Skill\"", "\"Bash(git:*)\"", "TaskCreate"]) expect(fm, p).not.toContain(p);
  });

  test("dispatch-task is user-only (disable-model-invocation: true)", () => {
    expect(read(F)).toMatch(/^disable-model-invocation:[ \t]*true/m);
  });

  test("dispatch-task skill dir is self-contained (no cross-plugin references)", () => {
    expect(files([DISPATCH]).filter((f) => /coding-toolbox|dispatch-agent|superpowers/i.test(read(f)))).toEqual([]);
  });

  test("dispatch-task supports --model/--effort overrides, defaults sonnet/xhigh, and forces permission-mode auto", () => {
    expectHas(F, ["claude --worktree", "--bg", "--model=<model>", "--effort=<effort>", "sonnet", "xhigh", "--permission-mode auto"]);
  });

  test("dispatch-task validates model/effort as safe bare tokens before shell substitution", () => {
    expectHas(F, ["^[A-Za-z0-9._-]+$"]);
  });

  test("dispatch-task constructs the command line with validated, not raw, model/effort values", () => {
    expectHas(F, ["claude --worktree \"$name\" --model \"<validated-model>\" --effort \"<validated-effort>\" --permission-mode auto --bg"]);
  });

  test("dispatch-task and its rule document worktree.baseRef instead of assuming the default branch unconditionally", () => {
    expectHas(F, ["worktree.baseRef", "\"head\""]);
    expectHas(DISPATCH_RULE, ["worktree.baseRef", "\"head\""]);
  });

  test("the dispatch-task rule documents the --skip-branch-check flag", () => {
    expectHas(DISPATCH_RULE, ["--skip-branch-check"]);
  });

  test("dispatch-task hardens the session name and any interpolated value", () => {
    expectHas(F, ["RANDOM", "date +%s", "^[A-Za-z0-9._-]+$"]);
  });

  test("dispatch-task hands the background session /taskflow:build-task inside a quoted heredoc", () => {
    expectHas(F, ["/taskflow:build-task"]);
    expect(read(F)).toMatch(/<<[ \t]?'DISPATCH_TASK_PROMPT_/);
  });

  test("dispatch-task uses a fixed heredoc delimiter (no fragile per-invocation token)", () => {
    expect(read(F).toLowerCase()).not.toContain("never reuse a fixed literal");
    expect(read(F).toLowerCase()).not.toContain("fresh heredoc");
    expect(read(F)).toMatch(/<<[ \t]?'DISPATCH_TASK_PROMPT_EOF'/);
  });

  test("dispatch-task cuts a properly named feature/<slug> branch before invoking build-task", () => {
    expectHas(F, ["git checkout -b", "feature/<"]);
  });

  test("dispatch-task payload passes --skip-branch-check to build-task", () => {
    expectHas(F, ["/taskflow:build-task --skip-branch-check"]);
  });

  test("plugin README lists dispatch-task in the Skills section", () => {
    expectHas(`${PLUGIN}/README.md`, ["| `dispatch-task`"]);
  });
});

describe("review-task skill", () => {
  const F = `${REVIEW_TASK}/SKILL.md`;

  test("review-task SKILL.md exists and is non-empty", () => {
    expect(nonEmpty(F)).toBe(true);
  });

  test("review-task frontmatter: name, description, argument-hint; model-invocable; not forked", () => {
    expect(read(F)).toMatch(/^name:[ \t]*review-task$/m);
    expect(read(F)).toMatch(/^description:/m);
    expect(read(F)).toMatch(/^argument-hint:/m);
    expect(read(F)).not.toMatch(/^disable-model-invocation:[ \t]*true/m);
    expect(read(F)).not.toMatch(/^context:[ \t]*fork/m);
  });

  test("review-task allowed-tools includes Bash, Skill and ToolSearch", () => {
    for (const t of ["Bash", "Skill", "ToolSearch"]) expect(read(F)).toMatch(new RegExp(`^allowed-tools:.*"${t}"`, "m"));
  });

  test("review-task parses --size, sizes itself, maps size to level, runs simplify then code-review --fix and commits", () => {
    expectHas(F, ["--size=", "mcp__taskflow__size-task", "own reasoning", "Review level: <level> (size <X>)", "`S` → `medium`, `M` → `high`, `L` → `xhigh`, `XL` → `max`", "\"simplify\"", "\"code-review\"", "--fix", "git status --porcelain", "git add -A"]);
    const simplify = read(F).indexOf("skill: \"simplify\"");
    expect(simplify).toBeGreaterThan(-1);
    expect(simplify).toBeLessThan(read(F).indexOf("skill: \"code-review\""));
  });

  test("review-task SKILL.md has no load-time exclamation-backtick sequence and mentions Co-Authored-By only to forbid it", () => {
    expectLacks(F, ["!`"]);
    const lines = read(F).split("\n").filter((l) => l.includes("Co-Authored-By"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/\bno\b/i);
  });

  test("review-task takes --headless, strips it before --size and routes decisions through taskflow:decide", () => {
    expect(read(F)).toMatch(/^argument-hint: "\[--headless\] \[--size=S\|M\|L\|XL\] \[base ref\]"$/m);
    for (const t of ["AskUserQuestion", "Agent"]) expect(read(F)).toMatch(new RegExp(`^allowed-tools:.*"${t}"`, "m"));
    expectHas(F, ["## Decisions", "Skill(skill: \"taskflow:decide\", args: \"[--headless] <JSON>\")", "`DECISIONS:`", "never call `AskUserQuestion` directly", "`Decided ...`"]);
    const strip = read(F).indexOf("Strip `--headless` first");
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(read(F).indexOf("then the `--size=<v>` token"));
    // AskUserQuestion survives only in allowed-tools and the never-call sentence
    for (const l of read(F).split("\n").filter((x) => x.includes("AskUserQuestion"))) expect(l).toMatch(/^allowed-tools:|never call `AskUserQuestion` directly/);
  });
});

describe("decide skill", () => {
  const F = `${PLUGIN}/skills/decide/SKILL.md`;

  test("decide frontmatter: name, AskUserQuestion and Agent allowed, model-invocable, inline", () => {
    expect(read(F)).toMatch(/^name:[ \t]*decide$/m);
    for (const t of ["AskUserQuestion", "Agent"]) expect(read(F)).toMatch(new RegExp(`^allowed-tools:.*"${t}"`, "m"));
    expect(read(F)).not.toMatch(/^disable-model-invocation:[ \t]*true/m);
    expect(read(F)).not.toMatch(/^context:[ \t]*fork/m);
  });

  test("decide body: --headless, advisor first, taskflow:decider fallback, DECISIONS line, error texts, no exclamation-backtick", () => {
    expectHas(F, ["--headless", "advisor()", "taskflow:decider", "DECISIONS:", "decide: invalid input:", "decide: no headless decision:", "Decided <id>: <answer> (<BY>: <reason>)", "Headless never falls back to `AskUserQuestion`"]);
    expectLacks(F, ["!`"]);
  });
});

describe("ship merge-state remediation wiring", () => {
  const SHIP = `${WORKFLOWS}/build-task-ship.workflow.js`;

  test("SHIP_RESULT declares optional mergeState enum; status enum unchanged", () => {
    expectHas(SHIP, ["mergeState: { enum: [\"clean\", \"rebased\", \"resolved\", \"unknown\"] }", "required: [\"status\"]"]);
  });

  test("ship script decodes PLUGIN_ROOT and threads the script path into the shipper prompt", () => {
    expectHas(SHIP, ["PLUGIN_ROOT", "ship-ensure-mergeable.mjs", "created.mergeState"]);
  });

  test("ship script's final ship comment documents the optional mergeState field", () => {
    expectHas(SHIP, ["mergeState?"]);
  });

  test("shipper references the remediation script, platform merge-state fields, and mergeState return", () => {
    expectHas(`${AGENTS}/shipper.md`, ["ship-ensure-mergeable.mjs", "mergeStateStatus", "detailed_merge_status", "mergeState"]);
  });

  test("build-task injects CLAUDE_PLUGIN_ROOT and passes PLUGIN_ROOT to the delivery workflow", () => {
    expectHas(`${SKILL}/SKILL.md`, ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"]);
  });

  test("build-task captures the plugin root via bare substitution, never a load-time shell injection", () => {
    expectHas(`${SKILL}/SKILL.md`, ["Plugin root: ${CLAUDE_PLUGIN_ROOT}"]);
    // the load-time preprocessor ignores markdown code spans: the two-char sequence must be absent from both bodies
    expectLacks(`${SKILL}/SKILL.md`, ["!`"]);
    expectLacks(`${DISPATCH}/SKILL.md`, ["!`"]);
  });

  test("no reverted-alternative pr_stale/pr_conflict strings survive anywhere in the plugin", () => {
    expect(sweep(TREE, /pr_stale|pr_conflict/)).toEqual([]);
  });

  test("the agent roster is exactly 11 *.md files", () => {
    expect(ls(AGENTS, ".md")).toHaveLength(11);
  });

  test("plugin README and layout document the review-task skill", () => {
    expectHas(`${PLUGIN}/README.md`, ["| `review-task`", "skills/review-task/", "/taskflow:review-task"]);
    expectLacks(`${PLUGIN}/README.md`, ["changes-review", "changes-audit", "build-task-review.workflow.js", "review-finder", "fix-applier", "ponytailReview"]);
  });

  test("CLAUDE.md boundary rule covers review-task, its size → level table and the 10 agents", () => {
    expectHas(DEV_NOTES, ["skills/review-task/", "10 static role prompts", "`S` → `medium`, `M` → `high`, `L` → `xhigh`, `XL` → `max`", "(../development/wiki/plugins/taskflow/design/review-task.md)"]);
    expectLacks(DEV_NOTES, ["changes-review", "changes-audit", "build-task-review.workflow.js", "13 static role prompts", "fix-applier", "review-finder"]);
  });
});

describe("PR/MR body handoff (pr-author → shipper)", () => {
  const SHIP = `${WORKFLOWS}/build-task-ship.workflow.js`;

  test("build-task passes SCRATCH_DIR to the delivery workflow", () => {
    expectHas(`${SKILL}/SKILL.md`, ["SCRATCH_DIR"]);
  });

  test("PR_TEXT schema hands off bodyPath, not an inline body", () => {
    expectHas(SHIP, ["bodyPath: { type: \"string\" }", "required: [\"title\", \"bodyPath\"]"]);
    // word boundary: a plain "prText.body" would match the surviving prText.bodyPath
    expect(read(SHIP)).not.toMatch(/prText\.body\b/);
    expectLacks(SHIP, ["<<<BODY"]);
  });

  test("shipper reads the PR/MR body from a file, never retyping it", () => {
    const F = `${AGENTS}/shipper.md`;
    expectHas(F, ["--body-file", "-F body=@", "--description \"$(cat"]);
    expectLacks(F, ["-f body="]);
  });

  test("pr-author writes the body to a file with the Write tool and returns bodyPath", () => {
    const F = `${AGENTS}/pr-author.md`;
    expectHas(F, ["bodyPath", "**Write tool**"]);
    expectLacks(F, ["Return the title and body through the structured output schema", "heredoc", "NEVER the Write or Edit tool", "universal-format"]);
    expect(read(F).toLowerCase()).not.toContain("bash redirection");
    expectHas(`${BT_WF}/ship.md`, ["with the Write tool (one retry)"]);
  });
});

describe("test-evidence handoff (implementer → reviewer)", () => {
  const IMPL = `${WORKFLOWS}/build-task-implement.workflow.js`;

  test("IMPL_RESULT hands off testEvidencePath, not an inline testEvidence transcript", () => {
    expectHas(IMPL, ["testEvidencePath: { type: \"string\" }", "\"testEvidencePath\", \"deviations\""]);
    expectLacks(IMPL, ["\"worktreePath\", \"testEvidence\", \"deviations\"", "testEvidence: { type: \"string\" }"]);
  });

  test("implementer keeps its pinned prompt head and redirects test evidence to the derived path", () => {
    expect(followedBy("implementerPrompt = (t, isolated) =>", "`${NO_NARRATION}", IMPL)).toBe(true);
    expectHas(IMPL, ["tevPathFor", "test-evidence-task-"]);
    expect(read(IMPL).toLowerCase()).toContain("bash redirection");
  });

  test("reviewer reads test evidence from the file named by testEvidencePath", () => {
    expect(followedBy("reviewerPrompt = (t, implReport, isolated) =>", "`${NO_NARRATION}", IMPL)).toBe(true);
    expectHas(IMPL, ["named by testEvidencePath"]);
  });

  test("implement script isolates and merges only multi-task waves", () => {
    expectHas(IMPL, ["isolated ? { isolation: \"worktree\" } : {}", "runTask(waveTasks[0], false)", "runTask(t, true)", "if (isolated && approved.length)", "single-task wave: no worktree, no merge step"]);
    expectLacks(IMPL, ["even for wave size 1"]);
  });

  test("implement reference documents single-task waves, not always-isolated", () => {
    expectHas(`${BT_WF}/implement.md`, ["single-task wave"]);
    expectLacks(`${BT_WF}/implement.md`, ["even for single-task waves"]);
  });
});

describe("ship merge-state documentation", () => {
  test("ship reference records mergeState in the ship contract and the auto-remediation roles", () => {
    expectHas(`${BT_WF}/ship.md`, ["mergeState?", "ship-ensure-mergeable"]);
    expect(read(`${BT_WF}/ship.md`).toLowerCase()).toContain("never merges the pr/mr itself");
  });

  test("README shipper row and file tree document bin/ship-ensure-mergeable.mjs", () => {
    expectHas(`${PLUGIN}/README.md`, ["ship-ensure-mergeable.mjs"]);
    expect(read(`${PLUGIN}/README.md`).toLowerCase()).toContain("merge-state");
  });

  test("CLAUDE.md documents ship-ensure-mergeable.mjs alongside the 10-agent roster", () => {
    expectHas(DEV_NOTES, ["ship-ensure-mergeable.mjs", "10 static role prompts"]);
  });
});

describe("ponytail design-phase enforcement", () => {
  test("designer prompt embeds the ponytail reuse ladder and the never-trim carve-out", () => {
    const md = read(`${AGENTS}/designer.md`);
    expect(md.toLowerCase()).toContain("reuse ladder");
    expect(md.toLowerCase()).toContain("stdlib");
    expect(md.toLowerCase()).toContain("no unrequested abstractions");
    expect(md).toContain("USER DECISION");
  });

  test("design-reviewer checklist includes the over-engineering (ponytail) item 8", () => {
    expect(read(`${AGENTS}/design-reviewer.md`).toLowerCase()).toContain("over-engineering (ponytail)");
    expect(read(`${AGENTS}/design-reviewer.md`)).toMatch(/^8\./m);
  });

  test("the spec-writer prompt carries the draft's lean/YAGNI decisions forward", () => {
    expect(read(`${WORKFLOWS}/build-task-spec.workflow.js`).toLowerCase()).toContain("lean/yagni decisions forward");
  });

  test("the ten build-task roles are plugin agents (INTERNAL ONLY, no-narration paragraph); no role files remain", () => {
    for (const r of ["designer", "design-reviewer", "planner", "spec-writer", "worktree-merger", "pr-author", "shipper", "ci-monitor", "ci-fixer", "explore-scribe"]) {
      const f = `${AGENTS}/${r}.md`;
      expect(nonEmpty(f), f).toBe(true);
      expect(existsSync(abs(`${SKILL}/roles/${r}.md`))).toBe(false);
      expectHas(f, [`name: ${r}`, "description: INTERNAL ONLY", "No narrative text between tool calls"]);
      expect(read(f)).toMatch(/^model: (haiku|sonnet|opus)$/m);
      expectLacks(f, ["design-to-spec", "spec-driven-delivery"]);
    }
    expectHas(`${AGENTS}/design-reviewer.md`, ["You are read-only: never use Write, Edit, NotebookEdit, or a Bash command that changes files or git state."]);
    expectHas(`${AGENTS}/explore-scribe.md`, ["tools: [\"Read\", \"Write\"]", "model: haiku"]);
    expect(existsSync(abs(`${WORKFLOWS}/design-to-spec.workflow.js`))).toBe(false);
  });

  test("pr-author documents the Lean review heading fed from the ponytail pass", () => {
    expect(read(`${AGENTS}/pr-author.md`).toLowerCase()).toContain("lean review");
  });
});

describe("graphmind", () => {
  test("plan script threads graphmind into the planner", () => {
    expectHas(`${WORKFLOWS}/build-task-plan.workflow.js`, ["GRAPHMIND_AVAILABLE", "mcp__graphmind__gm_search", "project: \"${REPO}\"", "GRAPHMIND_AVAILABLE=true requires a non-empty absolute REPO_PATH"]);
  });

  test("build-task probes graphmind once and threads it to both workflows", () => {
    expectHas(`${SKILL}/SKILL.md`, ["select:mcp__graphmind__gm_search", "graphmind which", "GRAPHMIND_AVAILABLE, REPO_PATH}"]);
  });

  test("reference docs document GRAPHMIND_AVAILABLE and REPO_PATH for the explore script and the plan script", () => {
    for (const f of ["workflows/explore.md", "workflows/plan.md"]) expectHas(`${SKILL}/${f}`, ["`GRAPHMIND_AVAILABLE`", "`REPO_PATH`"]);
  });

  test("the workflow rule documents the conditional graphmind path and README mentions graphmind", () => {
    expectHas(WF_RULE, ["## Conditional graphmind path (build-task explorers, delivery planner)", "graphmindExplorePrompt"]);
    expectHas(`${PLUGIN}/README.md`, ["graphmind which"]);
  });

  test("taskflow carries no repo-explorer references", () => {
    for (const p of ["repo-explorer", "EXPLORE_TOOL_AVAILABLE", "explore_repository"]) expect(sweep(TREE, new RegExp(lit(p), "i")), p).toEqual([]);
  });
});

describe("build-task delivery scripts", () => {
  test("plan.workflow.js: SIZE-keyed planner model, planner role file, no classifier, status exit contract", () => {
    const F = `${WORKFLOWS}/build-task-plan.workflow.js`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["name: \"build-task-plan\"", "decodeArgs([\"SPEC_PATH\", \"PLAN_PATH\"]", "const PLAN_MODEL = { S: \"sonnet\", M: \"opus\", L: \"opus\", XL: \"fable\" };", "const plannerModel = (s) => PLAN_MODEL[String(s).toUpperCase()] || \"opus\";", "let PLANNER_MODEL = plannerModel(SIZE);", "model: PLANNER_MODEL", "planChecker: \"sonnet\"", "if (PLANNER_MODEL !== \"fable\") throw e;", "PLANNER_MODEL = \"opus\";", "if (PLANNER_MODEL === \"fable\") {", "planner on fable returned null", "agentType: \"taskflow:planner\"", "planCheckerPrompt = `${NO_NARRATION}", "GRAPHMIND_AVAILABLE", "mcp__graphmind__gm_search", "project: \"${REPO}\"", "GRAPHMIND_AVAILABLE=true requires a non-empty absolute REPO_PATH", "must be an absolute path", "return { status: \"complete\", planPath: PLAN_PATH, plannerModel: PLANNER_MODEL };", "stage: \"Plan\", error: planned.reason, planPath: PLAN_PATH, plannerModel: PLANNER_MODEL"]);
    expectLacks(F, ["classify", "CLASSIFY_SCHEMA", "difficulty", "PINNED_OPUS", "agent definition", "stage: \"done\"", "hardest"]);
  });

  test("plan.md documents the plan script contract and the size-to-model table", () => {
    const F = `${BT_WF}/plan.md`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["taskflow:build-task-", "args global is undefined", "const args = { … }", "stage: 'args'", "`SPEC_PATH`", "`PLAN_PATH`", "`SIZE`", "`GRAPHMIND_AVAILABLE`", "`REPO_PATH`", "`planPath`", "`plannerModel`", "fable", "S sonnet / M opus / L opus / XL fable", "taskflow:planner", "## Contents", "## Preconditions"]);
    expectLacks(F, ["claude-opus-4-8", "spec-driven-delivery", "design-to-spec"]);
  });

  test("implement.workflow.js: plan loader with validation, wave rules, merger role file, Write scribe with Write retry, uniform returns", () => {
    const F = `${WORKFLOWS}/build-task-implement.workflow.js`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["name: \"build-task-implement\"", "decodeArgs([\"PLAN_PATH\", \"IMPLEMENT_PATH\", \"BRANCH_NAME\", \"SCRATCH_DIR\"]", "must be an absolute path", "loader: \"haiku\"", "merger: \"haiku\"", "scribe: \"haiku\"", "const implModel = (t) => (t.complexity === \"complex\" ? \"opus\" : \"haiku\");", "complex: \"sonnet\"", "label: \"load-plan\"", "label: \"load-plan:retry\"", "required: [\"constraints\", \"tasks\", \"taskHeadings\"]", "p.tasks.length === p.taskHeadings", "could not load the plan tasks from PLAN_PATH", "agentType: \"taskflow:worktree-merger\"", "protocol, and toplevel self-report per your role definition.", "testEvidencePath: { type: \"string\" }", "\"testEvidencePath\", \"deviations\"", "tevPathFor", "test-evidence-task-", "named by testEvidencePath", "isolated ? { isolation: \"worktree\" } : {}", "runTask(waveTasks[0], false)", "runTask(t, true)", "if (isolated && approved.length)", "single-task wave: no worktree, no merge step", "async function persist(path, obj)", "w.bytes === expectedBytes || w.bytes === expectedBytes + 1", "label: \"persist:retry\"", "with the Write tool", "agent(prompt, { ...opts, label: \"persist:retry\" })", "could not write IMPLEMENT_PATH — all tasks are committed on ", "return { status: \"complete\", implementPath: IMPLEMENT_PATH, tasks: taskList, waves, minorFindings: minorLedger };", "tasks: [], waves: [], results: [], minorFindings: []"]);
    for (const p of ["implementerPrompt = (t, isolated) =>", "reviewerPrompt = (t, implReport, isolated) =>", "fixerPrompt = (t, findings, worktreePath, branch) =>"]) expect(followedBy(p, "`${NO_NARRATION}", F), p).toBe(true);
    expect(read(F).toLowerCase()).toContain("bash redirection");
    // one definition plus one use in each of the implementer, reviewer and fixer prompts
    expect(countLines(F, "BASH_SHAPE_HINT")).toBe(4);
    expect(countLines(F, "${BASH_SHAPE_HINT}")).toBe(3);
    expectHas(F, ["const BASH_SHAPE_HINT = \"Bash commands: the worktree-isolation guard refuses $(...), ${!var}, git -C and a cd to a computed path before git", "into a file in \" + SCRATCH_DIR + \" with the Write tool"]);
    expectLacks(F, ["TASKFLOW_JSON_EOF", "<<'", "WRITE_VIA_BASH_NOT_WRITE_EDIT", "NEVER the Write or Edit tool", "retryPrompt", "classify", "PINNED_OPUS", "difficulty", "agent definition", "stage: \"done\"", "even for wave size 1", "tasks.length > 4", "SPEC_PATH", "BASE_BRANCH", "\"worktreePath\", \"testEvidence\", \"deviations\"", "testEvidence: { type: \"string\" }"]);
    // every return after the args check carries tasks, waves and minorFindings
    expect(read(F).split("\n").filter((l) => l.includes("stage: \"Implement\"") && !/tasks: .*waves.*minorFindings/.test(l))).toEqual([]);
  });

  test("implement.md documents the implement script contract and the wave rules", () => {
    const F = `${BT_WF}/implement.md`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["taskflow:build-task-", "args global is undefined", "const args = { … }", "stage: 'args'", "`PLAN_PATH`", "`IMPLEMENT_PATH`", "`BRANCH_NAME`", "`SCRATCH_DIR`", "`implementPath`", "`tasks`", "`waves`", "`minorFindings`", "`results`", "single-task wave", "taskflow:worktree-merger", "taskResults", "## Contents", "## Preconditions"]);
    expectLacks(F, ["claude-opus-4-8", "spec-driven-delivery", "even for single-task waves"]);
  });

  test("ship.workflow.js: result-file paths to pr-author, role files, CI loop bounds, reportable ship states", () => {
    const F = `${WORKFLOWS}/build-task-ship.workflow.js`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["name: \"build-task-ship\"", "decodeArgs([\"SPEC_PATH\", \"PLAN_PATH\", \"IMPLEMENT_PATH\", \"REVIEW_PATH\", \"PR_BODY_PATH\", \"BRANCH_NAME\"], { BASE_BRANCH: \"main\", PLUGIN_ROOT: \"\" })", "must be an absolute path", "A.PLUGIN_ROOT.includes(\"${\")", "prAuthor: \"haiku\"", "shipper: \"haiku\"", "ciMonitor: \"haiku\"", "ciFixer: \"sonnet\"", "agentType: \"taskflow:pr-author\"", "agentType: \"taskflow:shipper\"", "agentType: \"taskflow:ci-monitor\"", "agentType: \"taskflow:ci-fixer\"", "Pipeline result files (faithful source of truth — Read both): implement result ", "(tasks, waves, per-task minor findings), review result ", "(size, level, review commits, summary)", "PR_BODY_PATH", "bodyPath: { type: \"string\" }", "required: [\"title\", \"bodyPath\"]", "mergeState: { enum: [\"clean\", \"rebased\", \"resolved\", \"unknown\"] }", "required: [\"status\"]", "ship-ensure-mergeable.mjs", "created.mergeState", "mergeState?", "rerunId", "rerunTried", "const MAX_CI_MONITOR_ROUNDS = 6;", "const MAX_CI_FIX_ROUNDS = 2;", "with the Write tool", "label: \"pr-author:retry\"", "return { status: \"complete\", ship };"]);
    expectLacks(F, ["agent definition", "per your agent", "pipelineSummary", "SCRATCH_DIR", "if (SHIP)", "status: \"skipped\"", "stage: \"done\"", "classify", "PINNED_OPUS", "<<<BODY", "stage: \"Ship\"", "<<'EOF'", "WRITE_VIA_BASH_NOT_WRITE_EDIT", "NEVER the Write or Edit tool"]);
    // word boundary: a plain "prText.body" would match prText.bodyPath
    expect(read(F)).not.toMatch(/prText\.body\b/);
    // four role agents (pr-author, shipper, ci-monitor, ci-fixer), each dispatched through its agentType
    expect(countLines(F, "agentType: \"taskflow:")).toBe(4);
  });

  test("ship.md documents the ship script contract, mergeState and the stage's hard limits", () => {
    const F = `${BT_WF}/ship.md`;
    expect(nonEmpty(F)).toBe(true);
    expectHas(F, ["taskflow:build-task-", "args global is undefined", "const args = { … }", "stage: 'args'", "`SPEC_PATH`", "`PLAN_PATH`", "`IMPLEMENT_PATH`", "`REVIEW_PATH`", "`PR_BODY_PATH`", "`BRANCH_NAME`", "`BASE_BRANCH`", "`PLUGIN_ROOT`", "`ship`", "mergeState?", "ship-ensure-mergeable", "taskflow:pr-author", "taskflow:shipper", "taskflow:ci-monitor", "taskflow:ci-fixer", "## Contents", "## Preconditions"]);
    expect(read(F).toLowerCase()).toContain("never merges the pr/mr itself");
    expectLacks(F, ["claude-opus-4-8", "spec-driven-delivery", "`SHIP`", "`skipped`"]);
  });

  test("no delivery script keeps the classifier, the opus pin, the built-in Explore agent or the plan-derived review level", () => {
    for (const n of ["plan", "implement", "ship"]) {
      expectLacks(`${WORKFLOWS}/build-task-${n}.workflow.js`, ["classifyPrompt", "CLASSIFY_SCHEMA", "label: \"classify\"", "agentType: \"Explore\"", "difficulty", "PINNED_OPUS", "tasks.length > 4"]);
    }
    const bt = ls(WORKFLOWS, ".workflow.js").filter((n) => n.startsWith("build-task-")).map((n) => `${WORKFLOWS}/${n}`);
    expect(sweep(bt, /classify|PINNED_OPUS|tasks.length > 4/)).toEqual([]);
  });

  test("build-task SKILL.md step 5 runs plan, implement and ship with the documented args, review-task as Review, and one error rule", () => {
    const F = `${SKILL}/SKILL.md`;
    expectHas(F, ["{SPEC_PATH, PLAN_PATH, SIZE, GRAPHMIND_AVAILABLE, REPO_PATH, JEV_AVAILABLE}", "{PLAN_PATH, IMPLEMENT_PATH, BRANCH_NAME, SCRATCH_DIR, GRAPHMIND_AVAILABLE, REPO_PATH}", "Skill(skill: \"taskflow:review-task\", args: \"--size=<SIZE> <BASE_BRANCH>\")", "{\"size\": \"<SIZE>\", \"level\": \"<level>\", \"commits\": [", "{SPEC_PATH, PLAN_PATH, IMPLEMENT_PATH, REVIEW_PATH, PR_BODY_PATH, BRANCH_NAME, BASE_BRANCH, PLUGIN_ROOT, GRAPHMIND_AVAILABLE, REPO_PATH, JEV_AVAILABLE}", "PR/MR skipped at the user", "`SIZE` picks the designer model, the planner model and the review level.", "plannerModel", "never retry the merge", "half-implemented plan", "The one error rule for the script sub-steps"]);
    expectLacks(F, ["CLAUDE_PLUGIN_ROOT}/workflows", "Review error", "`S` or `M` → `high`", "taskflow:review-finder", "taskflow:review-verifier", "taskflow:fix-applier", "LEVEL, GRAPHMIND_AVAILABLE"]);
  });

  test("explore scribe is the Read/Write-only explore-scribe agent with a lens header/footer check and one retry; implement persist keeps the exact-size check", () => {
    const ex = `${WORKFLOWS}/build-task-explore.workflow.js`;
    expectHas(ex, ["Retry: the file may already exist from an earlier attempt; Read it first, then overwrite it.", "{ ...scribeOpts, label: \"scribe:retry\" })", "const lensProblems = (w) =>", "missing lens header(s): ", "lens header(s) without footer: ", "differ from the expected lenses in count or order", "Do not write anything. Read ", "reserved for the memory recall"]);
    expectLacks(ex, ["TASKFLOW_MD_EOF", "NEVER the Write or Edit tool", "scribeRetryPrompt", "isIntactRetry", "printf", "w.bytes", "0.9"]);
    expectHas(`${AGENTS}/explore-scribe.md`, ["tools: [\"Read\", \"Write\"]", "with the Write tool", "Read the file back", "never what the prompt contained"]);
    expectHas(`${BT_WF}/explore.md`, ["with the Write tool"]);
    for (const n of ["explore", "implement"]) expectLacks(`${WORKFLOWS}/build-task-${n}.workflow.js`, ["printf", "retryPrompt"]);
    expectLacks(`${BT_WF}/explore.md`, ["heredoc"]);
    for (const n of ["implement"]) {
      const f = `${WORKFLOWS}/build-task-${n}.workflow.js`;
      expect(countLines(f, "w.bytes === expectedBytes || w.bytes === expectedBytes + 1")).toBe(1);
      expectLacks(f, ["0.9"]);
      expectLacks(`${BT_WF}/${n}.md`, ["heredoc"]);
      expectHas(`${BT_WF}/${n}.md`, ["with the Write tool", "a trailing newline"]);
    }
    for (const d of [WF_RULE, `${BT_WF}/explore.md`, `${BT_WF}/implement.md`]) expectLacks(d, ["that count plus one", "byte count is verified"]);
  });

  test("rule, developer notes and SKILL.md describe the Write-only write path", () => {
    expectHas(WF_RULE, ["writes with the Write tool to the absolute scratchpad path", "the one retry is the same Write call", "a trailing newline", "pr-author writes `PR_BODY_PATH` with Write, its retry too", "end with `BASH_SHAPE_HINT`"]);
    expectLacks(WF_RULE, ["TASKFLOW_JSON_EOF", "TASKFLOW_MD_EOF", "never the Write or Edit tool", "the heredoc's newline"]);
    expectHas(DEV_NOTES, ["Pipeline files live in the session scratchpad and are written with the Write tool", "(../development/wiki/pitfalls/worktree-and-auto-mode-sessions.md)"]);
    expectHas(`${SKILL}/SKILL.md`, ["Pipeline files are written with the Write tool", "Only when no scratchpad is provided, run `mktemp -d -t build-task-XXXXXX`"]);
    expectLacks(`${SKILL}/SKILL.md`, ["unsure dispatched workers can read", "!`"]);
  });

  test("build-task ships six usage references and no role-file directory; the plugin keeps six workflows", () => {
    expect(existsSync(abs(`${SKILL}/roles`))).toBe(false);
    expect(ls(BT_WF, ".md")).toHaveLength(6);
    expect(ls(WORKFLOWS, ".workflow.js")).toHaveLength(6);
  });

  test("moved role files: ci-monitor is Bash-only by instruction, pr-author names the result files, planner stays English", () => {
    expectHas(`${AGENTS}/ci-monitor.md`, ["never Write, Edit or NotebookEdit, and never a Bash command that changes files or git state.", "tools: [\"Bash\", \"ToolSearch\", \"mcp__jev-api__request\"]", "the orchestrating workflow re-dispatches you"]);
    expectHas(`${AGENTS}/pr-author.md`, ["names the pipeline result files (implement result, review result) plus the spec and plan paths", "Match the repo's documentation language (README/existing PRs)."]);
    expectLacks(`${AGENTS}/pr-author.md`, ["structured pipeline", "Write that final message in English"]);
    expectHas(`${AGENTS}/planner.md`, ["Write the ENTIRE plan in English"]);
    for (const r of ["planner", "worktree-merger", "pr-author", "shipper", "ci-monitor", "ci-fixer"]) expectLacks(`${AGENTS}/${r}.md`, ["agent definition"]);
  });

  test("no spec-driven-delivery mention survives in the plugin or its developer notes", () => {
    expect(sweep(TREE, /spec-driven-delivery/)).toEqual([]);
  });

  test("dev notes and README describe the six build-task scripts, the role files and the size-driven choices", () => {
    expectHas(DEV_NOTES, ["build-task-plan.workflow.js", "build-task-implement.workflow.js", "build-task-ship.workflow.js", "implement-<slug>.json", "review-<slug>.json", "pr-body-<slug>.md", "agents/planner.md", "agents/shipper.md", "agents/worktree-merger.md", "carry a `tools` allowlist", "`--size=<SIZE>`", "`plan.md`, `implement.md`, `ship.md`"]);
    expectHas(WF_RULE, ["plan.workflow.js", "`S → sonnet`, `M → opus`, `L → opus`, `XL → fable`", "`review-task`", "carries `NO_NARRATION`"]);
    expectLacks(WF_RULE, ["CLASSIFY_SCHEMA", "simple → sonnet", "hardest", "agents/planner.md", "`LEVEL`", "changes-review", "build-task-review", "ponytailReview", "fix-applier", "review-finder"]);
    expectHas(`${PLUGIN}/README.md`, ["plan.workflow.js", "implement.workflow.js", "ship.workflow.js", "planner.md", "ci-fixer.md"]);
    expectLacks(`${PLUGIN}/README.md`, ["references/"]);
    expectHas(`${BT_WF}/spec.md`, ["input of the plan script"]);
  });

  test("tool hints: scripts append graphmind/jev-api hints only when the skill detected the tool", () => {
    for (const n of ["design", "implement", "ship"]) expectHas(`${WORKFLOWS}/build-task-${n}.workflow.js`, ["const gmHint = (purpose, project) =>", "GRAPHMIND_AVAILABLE=true requires a non-empty absolute REPO_PATH"]);
    for (const n of ["plan", "ship"]) expectHas(`${WORKFLOWS}/build-task-${n}.workflow.js`, ["A.JEV_AVAILABLE === true", "mcp__jev-api__request"]);
    expectHas(`${SKILL}/SKILL.md`, ["JEV_AVAILABLE = true"]);
  });
});

describe("removed review engine", () => {
  test("changes-audit, both review workflows, review.md and the three review agents are not shipped", () => {
    for (const p of [`${PLUGIN}/skills/changes-audit`, `${WORKFLOWS}/changes-review.workflow.js`, `${WORKFLOWS}/build-task-review.workflow.js`, `${BT_WF}/review.md`, `${AGENTS}/review-finder.md`, `${AGENTS}/review-verifier.md`, `${AGENTS}/fix-applier.md`]) {
      expect(existsSync(abs(p)), p).toBe(false);
    }
  });
});

describe("explore lens check documentation", () => {
  const WIKI = "development/wiki/plugins/taskflow/design/workflows.md";

  test("explore.md documents the three phases, the explore-scribe agent and the lens pairs, no size floor", () => {
    const F = `${BT_WF}/explore.md`;
    expectHas(F, ["`taskflow:explore-scribe`", "`## Lens: <name>`", "`_End of lens: <name>_`", "| `Scout`", "| `Explore`", "| `Scribe`", "only the design script, which reads the same file.", "`graphmind memory`", "with the Write tool"]);
    expectLacks(F, ["90%", "wc -c", "Recorded project knowledge", "No plugin agent dependency", "(and spec)"]);
  });

  test("developer notes and the workflow rule describe the explore-scribe agent and the ten agentType roles", () => {
    expectHas(DEV_NOTES, ["Ten of the plugin agents are build-task roles", "`explore-scribe`", "checks lens header/footer pairs instead of a byte count", "the lens header/footer lines come from the script", "(`SKILL.md` step 6)"]);
    expectLacks(DEV_NOTES, ["in the explore, implement and review scripts", "(`SKILL.md` step 5)", "Eight of the plugin agents", "the other ten have one"]);
    expectHas(WF_RULE, ["Ten roles are dispatched through a plugin `agentType`", "ten build-task roles", "`taskflow:explore-scribe` (`tools: Read, Write`)", "written as the lens `graphmind memory` (omitted when empty"]);
    expectLacks(WF_RULE, ["MIN_WRITE_RATIO", "Recorded project knowledge", "memory recall, scribe, spec writer", "Eleven roles", "Thirteen roles"]);
  });

  test("the wiki gives the reasons for the lens check and for the spec after the intent confirmation", () => {
    expectHas(WIKI, ["`agent()` call has no tools option", "runs the spec once, as step 4, after the \"Yes\""]);
    expectLacks(WIKI, ["90%"]);
  });
});

describe("review-task wiki page", () => {
  const PAGE = "development/wiki/plugins/taskflow/design/review-task.md";

  test("the wiki records why review-task replaced the review engine and its size → level table", () => {
    expectHas(PAGE, ["# review-task", "`S` → `medium`, `M` → `high`, `L` → `xhigh`, `XL` → `max`", "never `max`", "`REVIEW_PATH`", "## Accepted losses"]);
    expectHas("development/wiki/plugins/taskflow/index.md", ["(design/review-task.md)"]);
    expectHas("development/wiki/plugins/index.md", ["dispatch-task and review-task"]);
    expectLacks("development/wiki/plugins/taskflow/design/workflows.md", ["copies the review engine", "Lean (ponytail) review", "the 15 files"]);
  });
});
