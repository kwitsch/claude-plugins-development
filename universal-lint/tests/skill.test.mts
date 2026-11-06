// The /universal-lint:universal-lint skill (SKILL.md + lint-files.mjs); ported from test/universal-lint/skill.bats.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { DRIVER, makeEnv } from "./support/lint-hook.mts";

const SKILL = path.dirname(DRIVER);
const skillMd = readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? "";

/** Every file below the skill dir, as text. */
const skillFiles = readdirSync(SKILL, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => path.join(d.parentPath, d.name));

/** Run the driver on `paths` from the env's project dir. */
function driver(e: ReturnType<typeof makeEnv>, paths: string[], out = "") {
  const list = path.join(path.dirname(e.cwd), "list");
  writeFileSync(list, paths.join("\n") + "\n");
  return spawnSync(process.execPath, [DRIVER, list], { cwd: e.cwd, env: e.childEnv({ out }), encoding: "utf8" });
}

test("SKILL.md exists and is non-empty", () => {
  assert.ok(statSync(path.join(SKILL, "SKILL.md")).size > 0);
});

test("SKILL.md frontmatter: user-only, arguments file_scope, scoped allowed-tools (no bare Bash)", () => {
  assert.match(frontmatter, /disable-model-invocation: true/);
  assert.match(frontmatter, /arguments: file_scope/);
  assert.ok(frontmatter.includes("\"Glob\""));
  assert.ok(frontmatter.includes("\"AskUserQuestion\""));
  assert.ok(frontmatter.includes("\"Bash(git:*)\""));
  assert.ok(!frontmatter.includes("\"Bash\""));
});

test("SKILL.md points at the reference doc and invokes the driver via the literal token", () => {
  assert.ok(skillMd.includes("lint-files.reference.md"));
  assert.ok(skillMd.includes("${CLAUDE_SKILL_DIR}/lint-files.mjs"));
});

test("SKILL.md never writes the exclamation-mark-then-backtick injection sequence", () => {
  assert.ok(!skillMd.includes("!" + "`"));
});

test("driver and its reference are colocated at the skill root", () => {
  assert.ok(existsSync(path.join(SKILL, "lint-files.mjs")));
  assert.ok(existsSync(path.join(SKILL, "lint-files.reference.md")));
});

test("skill dir is self-contained (no cross-plugin references)", () => {
  for (const f of skillFiles) assert.doesNotMatch(readFileSync(f, "utf8"), /universal-format|coding-toolbox|taskflow/i, f);
});

test("driver never invokes a fix/format/write path (read-only)", () => {
  assert.doesNotMatch(readFileSync(DRIVER, "utf8"), /--fix|--format|--write/i);
});

test("skill dir does not use the off-label debounce knob", () => {
  for (const f of skillFiles) assert.ok(!readFileSync(f, "utf8").includes("UNIVERSAL_LINT_DEBOUNCE_MS"), f);
});

test("lint-files.mjs reports an aggregated finding for a supported file", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = driver(e, [e.file("a.sh", "echo $1\n")], "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SC2086/);
  assert.match(r.stdout, /universal-lint:/);
});

test("lint-files.mjs prints no-findings for a clean file", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 0);
  const r = driver(e, [e.file("a.sh", "echo hi\n")], "no problems");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no findings/);
});

test("lint-files.mjs skips an unsupported extension (.json): no findings, linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = driver(e, [e.file("a.json", "{\"a\":1}\n")], "x");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no findings/);
  assert.deepEqual(e.lines(), []);
});

test("lint-files.mjs exits 2 with no listfile argument", () => {
  const e = makeEnv();
  const r = spawnSync(process.execPath, [DRIVER], { env: e.childEnv(), encoding: "utf8" });
  assert.equal(r.status, 2);
});
