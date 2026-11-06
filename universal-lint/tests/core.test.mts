// Guard clauses and basic per-linter smoke tests (shellcheck/eslint/ruff/ktlint); ported from test/universal-lint/core.bats.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

/** A 4-line shell script; the Edit tests below edit line 2. */
const SH4 = "echo a\necho $1\necho b\necho $2\n";

test("Edit: only findings on the edited line are reported (exit 2, line-2 text only)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", SH4), {
    toolName: "Edit",
    toolInput: { new_string: "echo $1" },
    out: "a.sh:2:6: note: line2-marker [SC2086]\na.sh:4:6: note: line4-marker [SC2086]",
  });
  assert.equal(r.status, 2);
  assert.match(r.ctx, /line2-marker/);
  assert.doesNotMatch(r.ctx, /line4-marker/);
});

test("Edit: findings only outside the edited lines -> exit 0, no output", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", SH4), { toolName: "Edit", toolInput: { new_string: "echo $1" }, out: "a.sh:4:6: note: line4-marker [SC2086]" });
  assert.equal(r.status, 0);
  assert.equal(r.ctx, "");
});

test("Edit: a pure deletion (empty new_string) -> exit 0, linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", SH4), { toolName: "Edit", toolInput: { new_string: "" }, out: "a.sh:2:6: note: x [SC2086]" });
  assert.equal(r.status, 0);
  assert.deepEqual(e.lines(), []);
});

test("shellcheck finds an issue: exit 2 (asyncRewake) with the stub's text on stderr", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  e.recStub("shellcheck", 1);
  const r = e.run(f, { out: "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]" });
  assert.equal(r.status, 2);
  assert.match(r.ctx, /^universal-lint: shellcheck found issues/);
  assert.match(r.ctx, /SC2086/);
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
  assert.equal(readFileSync(f, "utf8"), "echo $1\n"); // linter never modifies the file
});

test("shellcheck clean (exit 0) -> {} even though it printed text", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 0);
  assert.deepEqual(e.run(e.file("a.sh", "echo \"$1\"\n"), { out: "no problems" }).result, {});
});

test("no linter on PATH -> {}", () => {
  const e = makeEnv();
  assert.deepEqual(e.run(e.file("a.sh", "echo $1\n")).result, {});
});

test("non-target extension (.txt) -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file("a.txt", "hi\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("path outside cwd -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const outside = makeEnv().file("a.sh", "echo $1\n");
  assert.deepEqual(e.run(outside, { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("node_modules path -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file("node_modules/x/a.sh", "echo $1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test(".claude/worktrees path -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file(".claude/worktrees/foo/a.sh", "echo $1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test(".claude/agent-memory path -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("yamllint", 1);
  assert.deepEqual(e.run(e.file(".claude/agent-memory/a.yaml", "a: 1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("*.local.* file -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file("settings.local.sh", "echo $1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test(".claude/rules path (not worktrees/agent-memory) -> linter still invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.run(e.file(".claude/rules/a.sh", "echo $1\n"), { out: "issue" });
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
});

test("eslint exit 2 (config/internal error) -> {} even though it printed text (skip, not issues)", () => {
  const e = makeEnv();
  e.recStub("eslint", 2);
  assert.deepEqual(e.run(e.file("a.js", "let x = 1\n"), { out: "Oops! Something went wrong! :(" }).result, {});
});

test("eslint exit 1 -> issues surfaced", () => {
  const e = makeEnv();
  e.recStub("eslint", 1);
  const r = e.run(e.file("a.js", "let x = 1\n"), { out: "a.js: 1:1  error  x is assigned a value but never used  no-unused-vars" });
  assert.match(r.ctx, /no-unused-vars/);
});

test("ruff check: subcommand precedes the file in recorded argv", () => {
  const e = makeEnv();
  e.recStub("ruff", 1);
  e.run(e.file("a.py", "x=1\n"), { out: "a.py:1:1: E225 missing whitespace around operator" });
  assert.ok(e.lines().some((l) => l.includes("ruff check")));
});

test("ktlint clean (exit 0) -> {}; issues (exit 1) -> surfaced", () => {
  const clean = makeEnv();
  clean.recStub("ktlint", 0);
  assert.deepEqual(clean.run(clean.file("a.kt", "fun main(){}\n")).result, {});
  const bad = makeEnv();
  bad.recStub("ktlint", 1);
  const r = bad.run(bad.file("a.kt", "fun main(){}\n"), { out: "a.kt:1:1: Missing newline before \")\" (standard:parameter-list-wrapping)" });
  assert.match(r.ctx, /parameter-list-wrapping/);
});

test("json extension -> linter never invoked (deliberately uncovered)", () => {
  const e = makeEnv();
  e.recStub("eslint", 1);
  assert.deepEqual(e.run(e.file("a.json", "{\"a\":1}"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});
