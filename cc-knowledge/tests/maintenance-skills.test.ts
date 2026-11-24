// Shape of the development tooling of the reference files: the project skills update-cc-references and
// dispatch-cc-references-update and the agent cc-reference-validator, all in this repository's `.claude/` (not shipped).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { frontmatter, PKG, PLUGIN, readRepo, REFS, ROOT } from "./support/plugin.ts";

const MAINT = readRepo(".claude/skills/update-cc-references/SKILL.md");
const MAINT_FM = frontmatter(MAINT);
const SOURCES_TEXT = readRepo(".claude/skills/update-cc-references/sources.json");
const DISPATCH = readRepo(".claude/skills/dispatch-cc-references-update/SKILL.md");
const DISPATCH_FM = frontmatter(DISPATCH);
const VALIDATOR = readRepo(".claude/agents/cc-reference-validator.md");
const VALIDATOR_FM = frontmatter(VALIDATOR);

test("update-cc-references is user-only (disable-model-invocation: true)", () => {
  expect(MAINT_FM.data["disable-model-invocation"]).toBe("true");
});

test("update-cc-references allowed-tools include fetch + edit + release tools, runs refresh.ts and ships its reference", () => {
  const tools = MAINT_FM.data["allowed-tools"] ?? "";
  for (const tool of ["Workflow", "Read", "Edit", "Write", "Glob", "Bash"]) expect(tools, tool).toContain(tool);
  expect(tools).not.toMatch(/Skill|WebSearch/);
  expect(MAINT.split("\n").length - 1).toBeLessThan(150);
  expect(MAINT.split("node ${CLAUDE_SKILL_DIR}/refresh.ts").length - 1).toBeGreaterThanOrEqual(2);
  expect(existsSync(join(ROOT, ".claude/skills/update-cc-references/refresh.reference.md"))).toBe(true);
  expect(existsSync(join(ROOT, ".claude/skills/update-cc-references/refresh.ts"))).toBe(true);
});

test("update-cc-references never falls back to WebFetch for content", () => {
  expect(MAINT_FM.data["allowed-tools"]).toBeDefined();
  expect(MAINT_FM.data["allowed-tools"]).not.toContain("WebFetch");
  expect(MAINT).toMatch(/curl/i);
});

test("cc-reference-validator is local-path-only, no WebFetch fallback", () => {
  expect(VALIDATOR).toMatch(/local file path/i);
  expect(VALIDATOR_FM.data["tools"] ?? "").not.toContain("WebFetch");
  expect(VALIDATOR).not.toMatch(/WebFetch/i);
});

test("update-cc-references covers the new targets and files", () => {
  const hint = MAINT_FM.data["argument-hint"] ?? "";
  for (const tok of ["commands", "mcp", "plugins", "memory", "settings"]) expect(hint, tok).toContain(tok);
  for (const f of ["commands", "mcp", "mcp-managed", "plugins", "memory", "settings"]) expect(SOURCES_TEXT, f).toContain(`claude-code-${f}.reference.md`);
});

test("update-cc-references release does a patch bump of package.json and rebuilds (no description date stamp)", () => {
  expect(MAINT).toMatch(/Patch version bump/i);
  expect(MAINT).toContain("cc-knowledge/package.json");
  expect(MAINT).toContain("pnpm --filter cc-knowledge build");
  expect(MAINT).not.toContain("CC docs read:");
  expect(MAINT).not.toMatch(/marketplace\.json/);
});

test("update-cc-references commits and opens the PR in this repository's style, staging package.json, assets/ and plugin/", () => {
  expect(MAINT).toContain("git add cc-knowledge/package.json cc-knowledge/assets/ cc-knowledge/plugin/");
  expect(MAINT).toContain("git commit -m \"cc-knowledge <version>: refresh the CC reference files\"");
  expect(MAINT).toMatch(/No `Co-Authored-By:` trailer/);
});

test("sources.json points at the migrated references and workflow.template.js at the plugin's section index", () => {
  expect(JSON.parse(SOURCES_TEXT).refsDir).toBe("cc-knowledge/assets/skills/cc-reference/references");
  expect(existsSync(join(ROOT, JSON.parse(SOURCES_TEXT).refsDir))).toBe(true);
  expect(existsSync(REFS)).toBe(true);
  expect(readRepo(".claude/skills/update-cc-references/workflow.template.js")).toContain("cc-knowledge/assets/skills/cc-reference/SKILL.md");
  expect(existsSync(join(PLUGIN, "skills/cc-reference/SKILL.md"))).toBe(true);
});

test("update-cc-references preserves the LSP not-loaded directive", () => {
  expect(SOURCES_TEXT).toContain("project-root `.lsp.json` is not loaded");
});

test("update-cc-references skill has the contradiction-validation gate", () => {
  expect(MAINT).toMatch(/Contradiction-validation gate/i);
  expect(MAINT).toContain("cc-reference-validator");
  expect(MAINT).toMatch(/git diff HEAD/i);
  expect(MAINT).toContain("UNVERIFIABLE");
});

test("update-cc-references Release is gated on the contradiction gate", () => {
  expect(MAINT).toMatch(/zero unconfirmed contradictions/i);
});

test("dispatch-cc-references-update is user-only (disable-model-invocation: true)", () => {
  expect(DISPATCH_FM.data["disable-model-invocation"]).toBe("true");
});

test("dispatch-cc-references-update allowed-tools is exactly Bash", () => {
  expect(DISPATCH_FM.data["allowed-tools"]).toBe("[\"Bash\"]");
});

test("dispatch-cc-references-update launch line pins fixed model haiku and effort high", () => {
  expect(DISPATCH).toContain("claude --worktree \"$name\" --model haiku --effort high --permission-mode auto --bg");
});

test("dispatch-cc-references-update payload starts with the slash command and cuts a timestamped fix branch", () => {
  expect(DISPATCH).toContain("fix/refresh-cc-references-<target>-$(date +%Y%m%d-%H%M%S)");
  // the line right after the heredoc opener must be the slash command
  const lines = DISPATCH.split("\n");
  const i = lines.indexOf("  cat << 'DISPATCH_CC_REFERENCES_PROMPT_EOF'");
  expect(i).toBeGreaterThan(-1);
  expect(lines[i + 1]).toBe("/update-cc-references <target>");
});

test("dispatch-cc-references-update keeps the safe-name regex", () => {
  expect(DISPATCH).toContain("^[A-Za-z0-9._-]+$");
});

test("dispatch-cc-references-update heredoc is single-quoted with the fixed delimiter", () => {
  expect(DISPATCH).toContain("cat << 'DISPATCH_CC_REFERENCES_PROMPT_EOF'");
  // opener line + terminator line are the only lines ending in the delimiter
  expect(DISPATCH.split("\n").filter((l) => /DISPATCH_CC_REFERENCES_PROMPT_EOF'?$/.test(l))).toHaveLength(2);
});

test("dispatch-cc-references-update argument-hint lists all 9 targets", () => {
  for (const tok of ["skills", "agents", "hooks", "commands", "mcp", "plugins", "memory", "settings", "all"]) expect(DISPATCH_FM.data["argument-hint"], tok).toContain(tok);
});

test("dispatch-cc-references-update states the worktree.baseRef conditional", () => {
  expect(DISPATCH).toContain("worktree.baseRef");
  expect(DISPATCH).toContain("\"head\"");
});

test("dispatch-cc-references-update has no bang-backtick injection sequence", () => {
  expect(DISPATCH.includes("!`")).toBe(false);
});

test("dispatch-cc-references-update names its origin in kwitsch/claude-plugins and links no file that does not exist here", () => {
  expect(DISPATCH).toContain("plugins/taskflow");
  expect(DISPATCH).not.toContain("dispatch-task/CLAUDE.md");
});

test("cc-reference-validator agent exists and is read-only", () => {
  expect(VALIDATOR_FM.data["name"]).toBe("cc-reference-validator");
  expect(VALIDATOR_FM.data["tools"]).toContain("Read");
  expect(VALIDATOR_FM.data["tools"]).not.toMatch(/Write|Edit/);
});

test("cc-reference-validator encodes the adversarial verdict discipline", () => {
  expect(VALIDATOR).toMatch(/verbatim/i);
  for (const verdict of ["CONFIRMED", "REJECTED", "UNVERIFIABLE"]) expect(VALIDATOR).toContain(verdict);
});

test("cc-reference-validator consults the advisor on difficult decisions when one is available", () => {
  expect(VALIDATOR).toMatch(/advisor/i);
  expect(VALIDATOR).toMatch(/available/i);
});

test("old rejected runtime-fetch artifacts are absent", () => {
  for (const gone of ["agents/cc-knowledge.md", "references", "skills/cck-skill", "skills/cck-agent", "skills/cck-rule", "skills/cck-hook"]) {
    expect(existsSync(join(PLUGIN, gone)), gone).toBe(false);
  }
});

test("package.json is the manifest source: claudePlugin marker, no userConfig, no CLAUDE.md inside plugin/", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { claudePlugin?: Record<string, unknown> };
  expect(pkg.claudePlugin).toEqual({});
  expect(existsSync(join(PLUGIN, "CLAUDE.md"))).toBe(false);
});
