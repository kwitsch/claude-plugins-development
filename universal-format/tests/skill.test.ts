// The `universal-format` skill: its SKILL.md contract and the built driver `format-files.mjs`, run as the skill runs
// it (a list file, the project as cwd) on the sandbox's PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { cleanup, PLUGIN, type Sandbox, sandbox } from "./support/mcp.ts";

afterEach(cleanup);

const SKILL = path.join(PLUGIN, "skills", "universal-format");
const DRIVER = path.join(SKILL, "format-files.mjs");
const skillMd = readFileSync(path.join(SKILL, "SKILL.md"), "utf8");

/**
 * Runs the driver in the sandbox's project with a list file naming the given paths.
 *
 * @param s - The sandbox.
 * @param files - The paths for the list file; none means no list file argument.
 * @returns The exit status and stdout.
 */
function drive(s: Sandbox, files: string[]): { status: number | null; stdout: string } {
  const list = path.join(s.root, "list");
  writeFileSync(list, files.join("\n") + "\n");
  return spawnSync(path.join(s.bin, "node"), files.length ? [DRIVER, list] : [DRIVER], { cwd: s.proj, encoding: "utf8", env: { PATH: s.bin, HOME: s.home, RECORD: path.join(s.root, "record") } });
}

test("SKILL.md frontmatter: user-only, arguments file_scope, scoped allowed-tools (no bare Bash)", () => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillMd)?.[1] ?? "";
  for (const part of ["name: universal-format", "disable-model-invocation: true", "arguments: file_scope", "\"Glob\"", "\"AskUserQuestion\"", "\"Bash(git:*)\""]) assert.ok(frontmatter.includes(part), part);
  assert.equal(frontmatter.includes("\"Bash\""), false);
});

test("SKILL.md points at the reference doc and runs the driver through ${CLAUDE_SKILL_DIR}", () => {
  assert.ok(skillMd.includes("format-files.reference.md"));
  assert.ok(skillMd.includes("${CLAUDE_SKILL_DIR}/format-files.mjs"));
});

test("SKILL.md never writes the exclamation-mark-then-backtick injection sequence", () => {
  assert.equal(skillMd.includes("!`"), false);
});

test("the skill directory holds the skill, the driver and its reference, and names no other plugin", () => {
  assert.deepEqual(readdirSync(SKILL).sort(), ["SKILL.md", "format-files.mjs", "format-files.reference.md"]);
  for (const f of readdirSync(SKILL)) assert.doesNotMatch(readFileSync(path.join(SKILL, f), "utf8"), /universal-lint|coding-toolbox|taskflow/i, f);
});

test("format-files.mjs reformats a prettier-language file in place", () => {
  const s = sandbox();
  const file = path.join(s.proj, "f.json");
  writeFileSync(file, "{\"a\":1}");
  const run = drive(s, [file]);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `formatted: ${file}\nuniversal-format: 1 formatted, 0 unchanged, 0 skipped (1 total)\n`);
  assert.equal(readFileSync(file, "utf8"), "{ \"a\": 1 }\n");
});

test("format-files.mjs runs the CLI formatter for a non-prettier language; a relative path resolves against the cwd", () => {
  const s = sandbox();
  writeFileSync(path.join(s.proj, "f.py"), "x=1\n");
  s.recStub("ruff");
  const run = drive(s, ["f.py"]);
  assert.equal(run.status, 0);
  assert.ok(run.stdout.startsWith("formatted: f.py\n"), run.stdout);
  assert.equal(s.recorded(), `ruff format --quiet --stdin-filename ${path.join(s.proj, "f.py")} -\n`);
  assert.equal(readFileSync(path.join(s.proj, "f.py"), "utf8"), "reformatted-by-ruff\n");
});

test("format-files.mjs skips an unsupported extension, reports an already formatted and a missing file, and exits 0", () => {
  const s = sandbox();
  writeFileSync(path.join(s.proj, "f.txt"), "hello\n");
  writeFileSync(path.join(s.proj, "ok.json"), "{ \"a\": 1 }\n");
  const run = drive(s, ["f.txt", "ok.json", "missing.json"]);
  assert.equal(run.status, 0);
  const lines = run.stdout.split("\n");
  assert.equal(lines[0], "skipped (unsupported): f.txt");
  assert.equal(lines[1], "unchanged: ok.json");
  assert.match(lines[2], /^skipped \(error: ENOENT.*\): missing\.json$/);
  assert.equal(lines[3], "universal-format: 0 formatted, 1 unchanged, 2 skipped (3 total)");
});

test("format-files.mjs exits 2 with no listfile argument", () => {
  assert.equal(drive(sandbox(), []).status, 2);
});
