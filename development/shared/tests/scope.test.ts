import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { hasClaudeInternal, isExcludedPath, outside, realish, relativeIfContains, walkToRoot } from "../src/scope.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "shared-scope-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("isExcludedPath: node_modules/vendor/.git segments -> excluded", () => {
  assert.equal(isExcludedPath(path.join("node_modules", "x", "a.sh")), true);
  assert.equal(isExcludedPath(path.join("vendor", "a.php")), true);
  assert.equal(isExcludedPath(path.join(".git", "hooks", "a.sh")), true);
});

test("isExcludedPath: .claude/worktrees and .claude/agent-memory -> excluded", () => {
  assert.equal(isExcludedPath(path.join(".claude", "worktrees", "foo", "a.sh")), true);
  assert.equal(isExcludedPath(path.join(".claude", "agent-memory", "a.md")), true);
});

test("isExcludedPath: other .claude/ subtrees (e.g. rules/agents/skills) stay covered", () => {
  assert.equal(isExcludedPath(path.join(".claude", "rules", "a.md")), false);
  assert.equal(isExcludedPath(path.join(".claude", "settings.json")), false);
});

test("isExcludedPath: a later .claude segment matching worktrees/agent-memory is still excluded, even after an earlier non-match", () => {
  assert.equal(isExcludedPath(path.join(".claude", "rules", ".claude", "worktrees", "foo", "a.sh")), true);
  assert.equal(isExcludedPath(path.join(".claude", "skills", ".claude", "agent-memory", "a.md")), true);
});

test("isExcludedPath: *.local.* files excluded regardless of location", () => {
  assert.equal(isExcludedPath(path.join(".claude", "settings.local.json")), true);
  assert.equal(isExcludedPath("docker-compose.local.yml"), true);
  assert.equal(isExcludedPath("a.sh"), false);
});

test("isExcludedPath: worktrees/agent-memory only under .claude, .local. only in the basename", () => {
  assert.equal(isExcludedPath(path.join("docs", "worktrees", "a.md")), false);
  assert.equal(isExcludedPath(path.join("src", "agent-memory", "a.ts")), false);
  assert.equal(isExcludedPath(path.join("conf.local.d", "a.sh")), false);
});

test("hasClaudeInternal: only a .claude segment followed by worktrees or agent-memory", () => {
  assert.equal(hasClaudeInternal([".claude", "worktrees", "x"]), true);
  assert.equal(hasClaudeInternal(["a", ".claude", "agent-memory"]), true);
  assert.equal(hasClaudeInternal([".claude", "rules"]), false);
  assert.equal(hasClaudeInternal([".claude"]), false);
});

test("outside / relativeIfContains: the dir itself and children are inside, siblings with a shared prefix and parents are not", () => {
  assert.equal(relativeIfContains("/a/b", "/a/b"), "");
  assert.equal(relativeIfContains("/a/b", "/a/b/c/d.txt"), path.join("c", "d.txt"));
  assert.equal(relativeIfContains("/a/b", "/a/bc/d.txt"), null);
  assert.equal(relativeIfContains("/a/b", "/a"), null);
  assert.equal(relativeIfContains("/a/b/", "/a/b/c"), "c", "a trailing separator on the dir does not matter");
  assert.equal(relativeIfContains("/", "/a/b"), path.join("a", "b"), "the root contains everything");
  assert.equal(outside(".."), true);
  assert.equal(outside(path.join("..", "x")), true);
  assert.equal(outside("..x"), false, "a name that merely starts with two dots is inside");
  assert.equal(outside(path.resolve("/x")), true, "another root (a relative() result on another drive) is outside");
});

test("realish: an existing path, a missing tail below an existing dir, and a symlinked dir are resolved to the real path", () => {
  const real = path.join(tmp, "real");
  mkdirSync(real);
  symlinkSync(real, path.join(tmp, "link"));
  const base = realish(tmp);
  assert.equal(realish(real), path.join(base, "real"));
  assert.equal(realish(path.join(tmp, "link", "new", "file.txt")), path.join(base, "real", "new", "file.txt"));
});

test("realish: a dangling symlink throws instead of falling back to the lexical path", () => {
  symlinkSync(path.join(tmp, "nowhere"), path.join(tmp, "dangling"));
  assert.throws(() => realish(path.join(tmp, "dangling")), { code: "ENOENT" });
  assert.throws(() => realish(path.join(tmp, "dangling", "x.txt")));
});

test("walkToRoot: walks up inclusive, stops at the first accepted directory, and reports false after the root", () => {
  const deep = path.join(tmp, "w", "x");
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(tmp, "w", "marker"), "");
  const seen: string[] = [];
  const hit = walkToRoot(deep, (d) => {
    seen.push(d);
    return d === path.join(tmp, "w");
  });
  assert.equal(hit, true);
  assert.deepEqual(seen, [deep, path.join(tmp, "w")]);
  const all: string[] = [];
  assert.equal(walkToRoot(deep, (d) => (all.push(d), false)), false);
  assert.equal(all.at(-1), path.parse(deep).root);
});
