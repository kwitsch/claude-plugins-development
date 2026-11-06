// File detection: SessionStart/CwdChanged watch list and FileChanged linting, against the built hook in a real git repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";
import type { LintEnv } from "./support/lint-hook.mts";

/**
 * Run the hermetic env's git in `dir`.
 *
 * @param e - Test environment (its `bin/git` and `childEnv`).
 * @param dir - Working directory.
 * @param args - git arguments.
 * @returns git's stdout.
 */
function git(e: LintEnv, dir: string, ...args: string[]): string {
  const r = spawnSync(path.join(e.bin, "git"), args, { cwd: dir, env: e.childEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * git init `dir` and commit everything present that is not gitignored.
 *
 * @param e - Test environment.
 * @param dir - Repository root; default the env's cwd.
 */
function gitInit(e: LintEnv, dir = e.cwd): void {
  git(e, dir, "init", "-q");
  git(e, dir, "add", "-A");
  git(e, dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

test("SessionStart: watchPaths = tracked + untracked lintable in-scope files only", () => {
  const e = makeEnv();
  e.file(".gitignore", "c.sh\n");
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  const b = e.file("b.sh", "echo b\n");
  e.file("c.sh", "echo c\n");
  e.file("node_modules/d.sh", "echo d\n");
  e.file("x.txt", "x\n");
  e.file("s/e.sh", "echo e\n");
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd, scratchpad_dir: path.join(e.cwd, "s") });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.watchPaths.length, 2);
  assert.deepEqual(new Set(out.hookSpecificOutput.watchPaths), new Set([a, b]));
});

test("CwdChanged: the list is built for new_cwd only; a non-git new_cwd prints nothing", () => {
  const e = makeEnv();
  e.file("a.sh", "echo a\n");
  const f = e.file("sub/f.sh", "echo f\n");
  gitInit(e);
  const r = e.runEvent({ hook_event_name: "CwdChanged", cwd: e.cwd, old_cwd: e.cwd, new_cwd: path.join(e.cwd, "sub") });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "CwdChanged");
  assert.deepEqual(out.hookSpecificOutput.watchPaths, [f]);

  const n = makeEnv();
  n.file("a.sh", "echo a\n");
  const r2 = n.runEvent({ hook_event_name: "CwdChanged", cwd: n.cwd, old_cwd: n.cwd, new_cwd: n.cwd });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, "");
});

test("SessionStart: above WATCH_LIMIT lintable files nothing is watched (stderr note)", () => {
  const e = makeEnv();
  for (let i = 1; i <= 5001; i++) writeFileSync(path.join(e.cwd, `f${i}.sh`), "");
  // Remove the git symlink first: writing the stub through it would overwrite the real git binary.
  rmSync(path.join(e.bin, "git"));
  e.stub("git", "for ((i=1; i<=5001; i++)); do printf 'f%d.sh\\0' \"$i\"; done");
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /above 5000/);
});
